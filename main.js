import { initializeApp } from "https://www.gstatic.com/firebasejs/12.17.1/firebase-app.js";
import { getDatabase, ref, set, get, update, remove, onValue, onDisconnect } from "https://www.gstatic.com/firebasejs/12.17.1/firebase-database.js";
// Firebase Authentication
import { getAuth, signInAnonymously } from "https://www.gstatic.com/firebasejs/12.17.1/firebase-auth.js";

// Firebase 設定
// [TASK 1] TURN 情報が未設定の場合は STUN のみで接続する
const TURN_URL = "";
const TURN_USERNAME = "";
const TURN_CREDENTIAL = "";
const ICE_TTL = 60 * 1000;

const firebaseConfig = {
    apiKey: "AIzaSyBgwdi7XhnG-bYn2hwAfO-s3n92ky_9eMo",
    authDomain: "aj-voice-call-e157e.firebaseapp.com",
    databaseURL: "https://aj-voice-call-e157e-default-rtdb.firebaseio.com",
    projectId: "aj-voice-call-e157e",
    storageBucket: "aj-voice-call-e157e.firebasestorage.app",
    messagingSenderId: "332396481182",
    appId: "1:332396481182:web:34f968fef4688254b2c98f",
    measurementId: "G-CBMJYWJW35"
};

// Firebase 初期化
const app = initializeApp(firebaseConfig);
const database = getDatabase(app);
// Auth インスタンス
const auth = getAuth(app);

// グローバル変数
let localStream = null;
let peerConnections = new Map();
let localPeerId = null;
let localDisplayName = '';
let isCallActive = false;
let activeStepNumber = 0;
// [TASK 2] peer 作成中の重複呼び出しを防止する
const creatingPeers = new Set();
let peerConnectionGeneration = 0;
let peersUnsub = null;
// [FEATURE 1] 個別ミュートと全ミュートの状態
let isMuted = false;
let isAllMuted = false;
const peerNames = new Map();
const peersRef = ref(database, 'peers');
// onDisconnect ハンドルと heartbeat
let onDisconnectHandle = null;
let heartbeatTimer = null;
const PEER_TTL = 5 * 60 * 1000; // 表示する最長寿命（ミリ秒）

// マップ：各ピアに紐づく購読解除関数
const peerListeners = new Map();
// マップ：リモート音声用の audio 要素
const remoteAudios = new Map();
// [FEATURE 3] peer ごとの音量処理と音量設定（退出後の再接続でも値を保持）
const peerGains = new Map();
const peerAudioSources = new Map();
const peerVolumes = new Map();
let audioContext = null;

// [TASK 1] TURN は URL / username / credential がそろった場合だけ追加する
function buildIceServers() {
    const iceServers = [
        { urls: ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302'] }
    ];
    if (TURN_URL && TURN_USERNAME && TURN_CREDENTIAL) {
        iceServers.push({
            urls: TURN_URL,
            username: TURN_USERNAME,
            credential: TURN_CREDENTIAL
        });
    }
    return iceServers;
}

const peerConnectionConfig = { iceServers: buildIceServers() };

// UI 要素
const statusEl = document.getElementById('status');
const startBtn = document.getElementById('startBtn');
const endBtn = document.getElementById('endBtn');
const peerListEl = document.getElementById('peerList');
const peersEl = document.getElementById('peers');
const displayNameInput = document.getElementById('displayName');
const muteBtn = document.getElementById('muteBtn');
const muteAllBtn = document.getElementById('muteAllBtn');

// イベントリスナー
startBtn.addEventListener('click', startCall);
endBtn.addEventListener('click', endCall);
muteBtn.addEventListener('click', () => setLocalMute(!isMuted));
muteAllBtn.addEventListener('click', () => setAllMute(!isAllMuted));
displayNameInput.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' && !startBtn.disabled) {
        startCall();
    }
});

// ユーティリティ
function normalizeDisplayName(raw) {
    return String(raw || '')
        .replace(/[\u0000-\u001F\u007F]/g, '')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, 20);
}

// [FEATURE 3] 通話開始ボタンのユーザー操作中に AudioContext を作成・再開する
async function initAudioContext() {
    if (!audioContext) {
        const AudioContextClass = window.AudioContext || window.webkitAudioContext;
        if (!AudioContextClass) {
            console.error('[AUDIO] Web Audio API が利用できません');
            return;
        }
        audioContext = new AudioContextClass();
    }

    if (audioContext.state === 'suspended') {
        try {
            await audioContext.resume();
        } catch (error) {
            logError('[AUDIO] AudioContext再開失敗', error);
        }
    }
}

// [FEATURE 1] 個別ミュート状態を保持し、全ミュート中はトラックを有効化しない
function setLocalMute(muted) {
    isMuted = muted;
    if (localStream) {
        localStream.getAudioTracks().forEach((track) => {
            track.enabled = !isMuted && !isAllMuted;
        });
    }
    muteBtn.textContent = isMuted ? 'ミュート解除' : 'ミュート';
    muteBtn.classList.toggle('btn-danger', isMuted);
    muteBtn.classList.toggle('btn-primary', !isMuted);
}

// [FEATURE 2] 個別ミュート状態を保持したまま、マイクと相手音声を一括で切り替える
function setAllMute(muted) {
    isAllMuted = muted;
    if (localStream) {
        localStream.getAudioTracks().forEach((track) => {
            track.enabled = !isMuted && !isAllMuted;
        });
    }
    for (const [peerId, audioEl] of remoteAudios) {
        audioEl.muted = isAllMuted;
        const gainNode = peerGains.get(peerId);
        if (gainNode) {
            gainNode.gain.value = isAllMuted ? 0 : (peerVolumes.get(peerId) || 0) / 100;
        }
    }
    muteAllBtn.textContent = isAllMuted ? '全ミュート解除' : '全ミュート';
    muteAllBtn.classList.toggle('btn-danger', isAllMuted);
    muteAllBtn.classList.toggle('btn-primary', !isAllMuted);
}

// [FEATURE 3] 音量スライダーの値（0〜200）を GainNode に反映する
function applyPeerVolume(peerId, value) {
    const volume = Math.max(0, Math.min(200, Math.round(Number(value))));
    peerVolumes.set(peerId, volume);
    const gainNode = peerGains.get(peerId);
    if (gainNode) {
        gainNode.gain.value = isAllMuted ? 0 : volume / 100;
    }
    updatePeerVolumeUI(peerId, volume);
}

// [FEATURE 3] peer の audio 要素を AudioContext の gain 経由で再生する
function attachGainToAudio(peerId, audioEl) {
    audioEl.muted = isAllMuted;
    const volume = peerVolumes.has(peerId) ? peerVolumes.get(peerId) : 100;
    peerVolumes.set(peerId, volume);

    if (!audioContext || peerGains.has(peerId)) {
        updatePeerVolumeUI(peerId, volume);
        return;
    }

    try {
        const source = audioContext.createMediaElementSource(audioEl);
        const gainNode = audioContext.createGain();
        gainNode.gain.value = volume / 100;
        source.connect(gainNode);
        gainNode.connect(audioContext.destination);
        peerAudioSources.set(peerId, source);
        peerGains.set(peerId, gainNode);
    } catch (error) {
        logError(`[AUDIO] GainNode接続失敗: peerId=${peerId}`, error);
    }
    updatePeerVolumeUI(peerId, volume);
}

// [FEATURE 3] peer 退出時に source / gain の接続を解除する
function detachGainFromPeer(peerId) {
    const source = peerAudioSources.get(peerId);
    if (source) {
        source.disconnect();
        peerAudioSources.delete(peerId);
    }
    const gainNode = peerGains.get(peerId);
    if (gainNode) {
        gainNode.disconnect();
        peerGains.delete(peerId);
    }
}

// [FEATURE 3] 一覧のスライダーと数値表示を更新する
function updatePeerVolumeUI(peerId, value) {
    const item = Array.from(peersEl.children).find((element) => element.dataset.peerId === peerId);
    if (!item) return;
    const slider = item.querySelector('.volume-slider');
    const valueLabel = item.querySelector('.volume-value');
    if (slider && slider.value !== String(value)) slider.value = String(value);
    if (valueLabel) valueLabel.textContent = String(value);
}

function peerRecord() {
    return {
        id: localPeerId,
        name: localDisplayName,
        timestamp: Date.now(),
        status: 'active'
    };
}

function updateStatus(message, type = 'normal') {
    statusEl.textContent = message;
    statusEl.className = `status ${type}`;
    console.log(`[STATUS] ${message}`);
}

function logError(prefix, error) {
    console.error(prefix, {
        code: error && error.code,
        name: error && error.name,
        message: error && error.message,
        error: error
    });
}

function logStep(number, message) {
    activeStepNumber = number;
    const text = `[STEP ${number}] ${message}`;
    console.log(text);
    updateStatus(text, 'connecting');
}

function logEnvironment() {
    const rtcAvailable = typeof window.RTCPeerConnection !== 'undefined';
    const rtcPrototype = rtcAvailable ? window.RTCPeerConnection.prototype : null;
    console.log('[ENV] location.protocol:', location.protocol);
    console.log('[ENV] location.host:', location.host);
    console.log('[ENV] navigator.userAgent:', navigator.userAgent);
    console.log('[ENV] navigator.mediaDevices:', !!navigator.mediaDevices);
    console.log('[ENV] navigator.mediaDevices.getUserMedia:', !!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia));
    console.log('[ENV] window.RTCPeerConnection:', rtcAvailable);
    console.log('[ENV] RTCPeerConnection.prototype.addTrack:', !!(rtcPrototype && rtcPrototype.addTrack));
    console.log('[ENV] ontrack in RTCPeerConnection.prototype:', !!(rtcPrototype && 'ontrack' in rtcPrototype));
    console.log('[ENV] navigator.getUserMedia:', !!(navigator.getUserMedia || navigator.webkitGetUserMedia || navigator.mozGetUserMedia));
}

async function checkNetwork(url) {
    console.log('[NET] fetch開始:', url);
    try {
        const response = await fetch(url);
        console.log('[NET] fetch成功:', url, 'HTTP', response.status, response.statusText, 'ok=', response.ok);
    } catch (error) {
        console.error('[NET] fetch失敗:', url, 'name=', error && error.name, 'message=', error && error.message, 'error=', error);
    }
}

async function checkMicrophone() {
    console.log('[MIC] 診断開始');
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
        console.error('[MIC] getUserMediaが利用できません');
        return;
    }
    try {
        const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
        console.log('[MIC] 診断用マイク取得成功');
        stream.getTracks().forEach((track) => track.stop());
        console.log('[MIC] 診断用トラックを停止しました');
    } catch (error) {
        console.error('[MIC] 診断用マイク取得失敗:', 'name=', error && error.name, 'message=', error && error.message, 'error=', error);
    }
}

function firebaseSet(databaseRef, value, path) {
    console.log('[FB] set開始:', path);
    return set(databaseRef, value).then((result) => {
        console.log('[FB] set成功:', path);
        return result;
    }).catch((error) => {
        logError(`[FB] set失敗: ${path}`, error);
        throw error;
    });
}

function firebaseUpdate(databaseRef, value, path) {
    console.log('[FB] update開始:', path);
    return update(databaseRef, value).then((result) => {
        console.log('[FB] update成功:', path);
        return result;
    }).catch((error) => {
        logError(`[FB] update失敗: ${path}`, error);
        throw error;
    });
}

function firebaseRemove(databaseRef, path) {
    console.log('[FB] remove開始:', path);
    return remove(databaseRef).then((result) => {
        console.log('[FB] remove成功:', path);
        return result;
    }).catch((error) => {
        logError(`[FB] remove失敗: ${path}`, error);
        throw error;
    });
}

function firebaseGet(databaseRef, path) {
    console.log('[FB] get開始:', path);
    return get(databaseRef).then((snapshot) => {
        console.log('[FB] get成功:', path, 'hasValue=', snapshot.exists());
        return snapshot;
    }).catch((error) => {
        logError(`[FB] get失敗: ${path}`, error);
        throw error;
    });
}

function firebaseOnValue(databaseRef, path, callback) {
    // [TASK 3] Firebase が返す購読解除関数を呼び出し元へ返す
    return onValue(databaseRef, (snapshot) => {
        const value = snapshot.val();
        console.log('[FB] onValue受信:', path, 'hasValue=', value !== null && value !== undefined);
        callback(snapshot);
    }, (error) => {
        logError(`[FB] onValue失敗: ${path}`, error);
    });
}

async function startCall() {
    try {
        logStep(1, 'startCall開始');
        const name = normalizeDisplayName(displayNameInput.value);
        if (!name) {
            console.error('[STEP 2] 名前バリデーション失敗: 表示名が空です');
            updateStatus('[STEP 2] 参加する前に表示名を入力してください', 'error');
            displayNameInput.focus();
            return;
        }
        localDisplayName = name;
        displayNameInput.value = name;
        logStep(2, `名前バリデーション完了: ${name}`);

        // [FEATURE 3] ユーザー操作中に AudioContext を初期化する
        await initAudioContext();

        // 匿名認証
        logStep(3, 'signInAnonymously開始');
        let authenticatedUser = null;
        try {
            const cred = await signInAnonymously(auth);
            authenticatedUser = cred.user;
            console.log('[FB] signInAnonymously成功');
        } catch (authError) {
            logError('[FB] signInAnonymously失敗', authError);
            // 既に認証済みの場合はエラーになるので無視
            if (authError.code !== 'auth/already-initialized') {
                throw authError;
            }
            // [TASK 9] 既に認証済みなら auth.currentUser をフォールバックに使う
            authenticatedUser = auth.currentUser;
        }

        // [TASK 9] signInAnonymously の戻り値を優先し、既存セッションは currentUser を使う
        const user = authenticatedUser || auth.currentUser;
        if (!user) {
            throw new Error('認証に失敗しました');
        }

        localPeerId = user.uid;
        logStep(4, `signInAnonymously成功: uid=${localPeerId}`);

        // マイクストリーム取得
        logStep(5, 'getUserMedia開始');
        localStream = await navigator.mediaDevices.getUserMedia({
            audio: {
                echoCancellation: true,
                noiseSuppression: true,
                autoGainControl: true
            },
            video: false
        });
        logStep(6, 'getUserMedia成功');

        isCallActive = true;
        updateStatus('通話ルームに参加中...', 'connecting');

        // Firebase に自分の情報を登録（myPeerRef を作る）
        const myPeerRef = ref(database, `peers/${localPeerId}`);
        // [TASK 7] onDisconnect を一度登録してから update で初期情報を登録する
        logStep(7, 'onDisconnect設定');
        try {
            onDisconnectHandle = onDisconnect(myPeerRef);
            await onDisconnectHandle.remove();
            console.log('[FB] onDisconnect設定成功:', `peers/${localPeerId}`);
        } catch (e) {
            logError('[FB] onDisconnect設定失敗', e);
            onDisconnectHandle = null;
        }

        logStep(8, `peers/${localPeerId} への update開始`);
        await firebaseUpdate(myPeerRef, peerRecord(), `peers/${localPeerId}`);
        logStep(9, 'peers update成功');

        // [TASK 7] heartbeat では timestamp だけを更新し、onDisconnect は再登録しない
        logStep(10, 'heartbeat開始');
        heartbeatTimer = setInterval(() => {
            firebaseUpdate(myPeerRef, { timestamp: Date.now() }, `peers/${localPeerId}`).catch((e) => logError('[FB] heartbeat失敗', e));
        }, 10000); // 10秒ごと

        // 既存の参加者を監視
        logStep(11, 'monitorPeers開始');
        monitorPeers();

        // UI 更新
        startBtn.disabled = true;
        endBtn.disabled = false;
        displayNameInput.disabled = true;
        // [FEATURE 1/2] 通話中だけミュート操作を有効にし、開始時は解除状態にする
        setLocalMute(false);
        setAllMute(false);
        muteBtn.disabled = false;
        muteAllBtn.disabled = false;
        updateStatus('[STEP 11] 通話待機中...接続を待っています', 'connected');

    } catch (error) {
        logError('[STEP] startCall失敗', error);
        localDisplayName = '';
        displayNameInput.disabled = false;
        updateStatus(`[STEP ${activeStepNumber}] エラー: ${error.name || 'Error'} ${error.code || ''} ${error.message || error}`, 'error');
    }
}

async function endCall() {
    try {
        updateStatus('通話を終了中...', 'connecting');

        // 自分を peers から消す前に監視を止める。
        isCallActive = false;
        if (peersUnsub) {
            peersUnsub();
            peersUnsub = null;
        }

        if (heartbeatTimer) {
            clearInterval(heartbeatTimer);
            heartbeatTimer = null;
        }

        // [TASK 8] 相手 ID を保持し、PC を閉じてから相手別シグナリングデータを削除する
        const connectedPeerIds = Array.from(peerConnections.keys());
        for (const peerId of connectedPeerIds) {
            cleanupPeer(peerId);
            const pc = peerConnections.get(peerId);
            if (pc) {
                pc.onicecandidate = null;
                pc.ontrack = null;
                pc.onconnectionstatechange = null;
                try { pc.close(); } catch (e) { /* noop */ }
            }
            peerConnections.delete(peerId);
        }

        if (localStream) {
            localStream.getTracks().forEach(track => track.stop());
            localStream = null;
        }

        // [FEATURE 1/2] 通話終了時にミュート状態とボタンをリセットする
        isMuted = false;
        isAllMuted = false;
        muteBtn.textContent = 'ミュート';
        muteBtn.classList.remove('btn-danger');
        muteBtn.classList.add('btn-primary');
        muteBtn.disabled = true;
        muteAllBtn.textContent = '全ミュート';
        muteAllBtn.classList.remove('btn-danger');
        muteAllBtn.classList.add('btn-primary');
        muteAllBtn.disabled = true;

        // [FEATURE 3] AudioContext を閉じ、GainNode を解放する
        for (const peerId of Array.from(peerGains.keys())) {
            detachGainFromPeer(peerId);
        }
        if (audioContext) {
            try { await audioContext.close(); } catch (error) { logError('[AUDIO] AudioContext終了失敗', error); }
            audioContext = null;
        }

        if (onDisconnectHandle) {
            try { await onDisconnectHandle.cancel(); } catch (e) { /* ignore */ }
            onDisconnectHandle = null;
        }

        if (localPeerId) {
            await firebaseRemove(ref(database, `peers/${localPeerId}`), `peers/${localPeerId}`);
            // [TASK E] 相手ごとのシグナリングデータ削除を並列実行する
            await Promise.all(connectedPeerIds.flatMap((peerId) => [
                firebaseRemove(ref(database, `offers/${localPeerId}/${peerId}`), `offers/${localPeerId}/${peerId}`),
                firebaseRemove(ref(database, `answers/${localPeerId}/${peerId}`), `answers/${localPeerId}/${peerId}`),
                firebaseRemove(ref(database, `iceCandidates/${localPeerId}/${peerId}`), `iceCandidates/${localPeerId}/${peerId}`)
            ]));
        }

        localPeerId = null;
        localDisplayName = '';
        peerNames.clear();

        // UI 更新
        startBtn.disabled = false;
        endBtn.disabled = true;
        displayNameInput.disabled = false;
        peerListEl.style.display = 'none';
        peersEl.innerHTML = '';
        updateStatus('通話を終了しました', 'normal');

    } catch (error) {
        logError('[STEP] endCall失敗', error);
        updateStatus(`エラー: ${error.name || 'Error'} ${error.code || ''} ${error.message || error}`, 'error');
    }
}

function cleanupPeer(peerId) {
    // [TASK 3] オフライン/切断時に各種リスナーの解除関数を順に呼ぶ
    const unsubscribers = peerListeners.get(peerId);
    if (unsubscribers) {
        for (const unsubscribe of unsubscribers) {
            try { unsubscribe(); } catch (e) { /* noop */ }
        }
        peerListeners.delete(peerId);
    }

    // リモートオーディオ要素を削除
    const audioEl = remoteAudios.get(peerId);
    if (audioEl) {
        audioEl.pause();
        audioEl.srcObject = null;
        audioEl.remove();
        remoteAudios.delete(peerId);
    }
    // [FEATURE 3] peer 退出時に音量処理ノードを破棄する
    detachGainFromPeer(peerId);
}

function isCurrentPeerConnection(peerId, peerConnection) {
    return isCallActive && peerConnections.get(peerId) === peerConnection;
}

async function monitorPeers() {
    // [TASK 3] monitorPeers の購読解除関数を endCall で呼び出せるよう保持する
    peersUnsub = firebaseOnValue(peersRef, 'peers', async (snapshot) => {
        if (!isCallActive) return;

        const peers = snapshot.val() || {};

        // ===== デバッグ：フィルタ前の全ピアを表示 =====
        console.log('[PEERS-RAW] 全ピア:', Object.keys(peers));
        console.log('[PEERS-RAW] localPeerId:', localPeerId);
        const now = Date.now();
        console.log('[PEERS-RAW] now:', now);
        for (const [id, data] of Object.entries(peers)) {
            const age = now - (data.timestamp || 0);
            console.log(`[PEERS-RAW] id=${id} name=${data && data.name} timestamp=${data && data.timestamp} age(ms)=${age} TTL=${PEER_TTL} passTTL=${age < PEER_TTL} isSelf=${id === localPeerId}`);
        }

        // 自分以外で、かつ最近更新されたピアだけ表示する（PEER_TTL を参照）
        const peerIds = Object.entries(peers)
            .filter(([id, data]) => id !== localPeerId && (Date.now() - (data.timestamp || 0) < PEER_TTL))
            .map(([id, data]) => {
                peerNames.set(id, normalizeDisplayName(data && data.name) || id.slice(0, 8));
                return id;
            });

        // ===== デバッグ：フィルタ後のピアを表示 =====
        console.log('[PEERS-FILTERED] 接続対象:', peerIds);

        // 接続していない新しいピアに接続
        for (const peerId of peerIds) {
            if (!isCallActive) return;
            // [TASK 2] peer 作成の二重実行を抑止する
            if (!peerConnections.has(peerId) && !creatingPeers.has(peerId)) {
                const initiator = localPeerId > peerId;
                console.log('[PEERS-FILTERED] createPeerConnection呼び出し:', peerId, 'initiator=', initiator);
                creatingPeers.add(peerId);
                try {
                    await createPeerConnection(peerId, initiator);
                } finally {
                    creatingPeers.delete(peerId);
                }
            }
        }

        // 削除されたピアの接続をクローズ
        for (const peerId of Array.from(peerConnections.keys())) {
            if (!peerIds.includes(peerId)) {
                cleanupPeer(peerId);
                const pc = peerConnections.get(peerId);
                if (pc) pc.close();
                peerConnections.delete(peerId);
                peerNames.delete(peerId);
            }
        }

        updatePeerList(peerIds);
    });
}

function updatePeerList(peerIds) {
    if (peerIds.length === 0) {
        peerListEl.style.display = 'none';
        peersEl.replaceChildren();
        return;
    }

    peerListEl.style.display = 'block';
    peersEl.replaceChildren();
    for (const peerId of peerIds) {
        const pc = peerConnections.get(peerId);
        const status = pc && pc.connectionState === 'connected' ? '接続済み' : '接続中...';
        const item = document.createElement('div');
        item.className = 'peer-item';
        item.dataset.peerId = peerId;
        const nameEl = document.createElement('span');
        nameEl.textContent = peerNames.get(peerId) || peerId.slice(0, 8);
        const connectionStatusEl = document.createElement('span');
        connectionStatusEl.className = 'peer-status';
        connectionStatusEl.textContent = status;
        const peerInfo = document.createElement('div');
        peerInfo.className = 'peer-info';
        peerInfo.append(nameEl, connectionStatusEl);

        // [FEATURE 3] peer ごとの音量スライダーと数値表示
        const volumeControl = document.createElement('div');
        volumeControl.className = 'volume-control';
        const volumeLabel = document.createElement('label');
        volumeLabel.textContent = '音量';
        const volumeSlider = document.createElement('input');
        volumeSlider.type = 'range';
        volumeSlider.className = 'volume-slider';
        volumeSlider.min = '0';
        volumeSlider.max = '200';
        volumeSlider.step = '1';
        const volume = peerVolumes.has(peerId) ? peerVolumes.get(peerId) : 100;
        volumeSlider.value = String(volume);
        const volumeValue = document.createElement('span');
        volumeValue.className = 'volume-value';
        volumeValue.textContent = String(volume);
        volumeSlider.addEventListener('input', () => applyPeerVolume(peerId, volumeSlider.value));
        volumeControl.append(volumeLabel, volumeSlider, volumeValue);

        item.append(peerInfo, volumeControl);
        peersEl.appendChild(item);
    }
}

async function createPeerConnection(peerId, initiator) {
    try {
        // [TASK 2] monitorPeers 側のガードに加え、生成直前にも二重作成を防ぐ
        if (peerConnections.has(peerId)) return;
        if (!isCallActive || !localPeerId) return;

        console.log('[RTC] createPeerConnection:', 'peerId=', peerId, 'initiator=', initiator);
        const peerConnection = new RTCPeerConnection(peerConnectionConfig);
        // [TASK 6] 古い PeerConnection からの書き込みを識別する世代番号
        peerConnection.generation = ++peerConnectionGeneration;
        peerConnections.set(peerId, peerConnection);
        const pendingIce = [];
        const appliedIceKeys = new Set();
        const pendingIceKeys = new Set();
        // [TASK 5] ICE の追加と pending キューの操作を peer ごとに直列化する
        peerConnection._iceQueue = Promise.resolve();

        function queueIceOperation(operation) {
            const queued = peerConnection._iceQueue.then(operation);
            peerConnection._iceQueue = queued.catch((error) => {
                logError(`[RTC] ICEキュー処理失敗: peerId=${peerId}`, error);
            });
            return queued;
        }

        // ローカルストリーム追加
        if (localStream) {
            localStream.getTracks().forEach(track => {
                peerConnection.addTrack(track, localStream);
            });
        }

        async function applyRemoteIceCandidate(candidateKey, ice) {
            if (!isCurrentPeerConnection(peerId, peerConnection)) return;
            if (appliedIceKeys.has(candidateKey)) return;
            if (!peerConnection.remoteDescription) {
                if (!pendingIceKeys.has(candidateKey)) {
                    pendingIce.push([candidateKey, ice]);
                    pendingIceKeys.add(candidateKey);
                }
                return;
            }
            try {
                await peerConnection.addIceCandidate(ice);
                appliedIceKeys.add(candidateKey);
            } catch (error) {
                if (peerConnection.signalingState !== 'closed') {
                    logError(`[RTC] ICE候補追加失敗: peerId=${peerId}`, error);
                }
            }
        }

        async function addRemoteIceCandidate(candidateKey, candidateData) {
            return queueIceOperation(() => applyRemoteIceCandidate(candidateKey, {
                candidate: candidateData.candidate,
                sdpMLineIndex: candidateData.sdpMLineIndex,
                sdpMid: candidateData.sdpMid
            }));
        }

        async function flushPendingIce() {
            return queueIceOperation(async () => {
                const queued = pendingIce.splice(0);
                for (const [candidateKey, ice] of queued) {
                    await applyRemoteIceCandidate(candidateKey, ice);
                    // [TASK D] 処理が終わってから queued key を解放する
                    pendingIceKeys.delete(candidateKey);
                }
            });
        }

        // ICE候補を処理
        peerConnection.onicecandidate = (event) => {
            peerConnection.iceCandidateEventCount = (peerConnection.iceCandidateEventCount || 0) + 1;
            console.log('[RTC] onicecandidate:', 'peerId=', peerId, 'count=', peerConnection.iceCandidateEventCount, 'hasCandidate=', !!event.candidate);
            
            if (!event.candidate) return;
            if (!isCurrentPeerConnection(peerId, peerConnection) || !localPeerId) return;
            const candidateKey = Math.random().toString(36).slice(2);
            if (!isCurrentPeerConnection(peerId, peerConnection) || !localPeerId) return;
            // [TASK B] 世代が一致しない古い pc からは候補を書き込まない
            if (peerConnections.get(peerId)?.generation !== peerConnection.generation) return;
            firebaseSet(ref(database, `iceCandidates/${localPeerId}/${peerId}/${candidateKey}`), {
                candidate: event.candidate.candidate,
                sdpMLineIndex: event.candidate.sdpMLineIndex,
                sdpMid: event.candidate.sdpMid,
                timestamp: Date.now()
            }, `iceCandidates/${localPeerId}/${peerId}/${candidateKey}`).catch((error) => logError('[RTC] ICE候補保存失敗', error));
        };

        // リモートストリームを受け取る
        peerConnection.ontrack = (event) => {
            console.log('[RTC] ontrack:', 'peerId=', peerId, 'hasStream=', !!(event.streams && event.streams[0]));
            let audioEl = remoteAudios.get(peerId);
            if (!audioEl) {
                audioEl = document.createElement('audio');
                audioEl.autoplay = true;
                audioEl.controls = false;
                // [TASK C] iOS Safari でインライン再生する
                audioEl.setAttribute('playsinline', '');
                audioEl.style.display = 'none';
                document.body.appendChild(audioEl);
                remoteAudios.set(peerId, audioEl);
            }
            // [FEATURE 2/3] 全ミュート状態を適用し、GainNode 経由で個別音量を制御する
            attachGainToAudio(peerId, audioEl);
            if (event.streams && event.streams[0]) {
                audioEl.srcObject = event.streams[0];
            }
        };

        // 接続状態の変化を監視
        peerConnection.onconnectionstatechange = () => {
            console.log('[RTC] onconnectionstatechange:', 'peerId=', peerId, 'state=', peerConnection.connectionState);
            if (!isCurrentPeerConnection(peerId, peerConnection)) return;
            updatePeerList(Array.from(peerConnections.keys()));
            if (peerConnection.connectionState === 'failed' || peerConnection.connectionState === 'closed') {
                cleanupPeer(peerId);
                if (peerConnections.get(peerId) === peerConnection) {
                    try { peerConnection.close(); } catch (e) { /* noop */ }
                    peerConnections.delete(peerId);
                }
            }
        };

        peerConnection.oniceconnectionstatechange = () => {
            console.log('[RTC] oniceconnectionstatechange:', 'peerId=', peerId, 'state=', peerConnection.iceConnectionState);
        };
        peerConnection.onsignalingstatechange = () => {
            console.log('[RTC] onsignalingstatechange:', 'peerId=', peerId, 'state=', peerConnection.signalingState);
        };

        if (initiator) {
            console.log('[RTC] createOffer開始:', peerId);
            const offer = await peerConnection.createOffer();
            console.log('[RTC] createOffer成功:', peerId);

            if (!isCurrentPeerConnection(peerId, peerConnection)) return;
            console.log('[RTC] setLocalDescription(offer)開始:', peerId);
            await peerConnection.setLocalDescription(offer);
            console.log('[RTC] setLocalDescription(offer)成功:', peerId);

            // [TASK 6] Firebase 書き込み直前にも現在の pc か確認する
            if (peerConnections.get(peerId) !== peerConnection || !isCurrentPeerConnection(peerId, peerConnection) || !localPeerId) return;

            await firebaseSet(ref(database, `offers/${localPeerId}/${peerId}`), {
                sdp: peerConnection.localDescription.sdp,
                type: 'offer',
                timestamp: Date.now()
            }, `offers/${localPeerId}/${peerId}`);
        }

        // [TASK 6] polite 側は rollback して着信 Offer を受け、impolite 側は自分の Offer を維持する
        const polite = localPeerId < peerId;
        let handlingOffer = false;
        async function answerRemoteOffer(offerData, isGlare) {
            try {
                console.log(`[RTC] ${isGlare ? 'glare ' : ''}setRemoteDescription(offer)開始:`, peerId);
                await peerConnection.setRemoteDescription({ type: 'offer', sdp: offerData.sdp });
                console.log(`[RTC] ${isGlare ? 'glare ' : ''}setRemoteDescription(offer)成功:`, peerId);
                await flushPendingIce();
                console.log(`[RTC] ${isGlare ? 'glare ' : ''}createAnswer開始:`, peerId);
                const answer = await peerConnection.createAnswer();
                console.log(`[RTC] ${isGlare ? 'glare ' : ''}createAnswer成功:`, peerId);
                console.log(`[RTC] ${isGlare ? 'glare ' : ''}setLocalDescription(answer)開始:`, peerId);
                await peerConnection.setLocalDescription(answer);
                console.log(`[RTC] ${isGlare ? 'glare ' : ''}setLocalDescription(answer)成功:`, peerId);
                if (peerConnections.get(peerId) !== peerConnection || !isCurrentPeerConnection(peerId, peerConnection) || !localPeerId) return;
                // [TASK B] 世代が一致しない古い pc からは answer を書き込まない
                if (peerConnections.get(peerId)?.generation !== peerConnection.generation) return;
                await firebaseSet(ref(database, `answers/${localPeerId}/${peerId}`), {
                    sdp: peerConnection.localDescription.sdp,
                    type: 'answer',
                    timestamp: Date.now()
                }, `answers/${localPeerId}/${peerId}`);
            } catch (err) {
                logError(`[RTC] ${isGlare ? 'Glare ' : ''}Offer処理失敗`, err);
            }
        }

        // リモートピアからの Offer を監視
        const remoteOfferRef = ref(database, `offers/${peerId}/${localPeerId}`);
        const remoteOfferUnsub = firebaseOnValue(remoteOfferRef, `offers/${peerId}/${localPeerId}`, async (snapshot) => {
            const offerData = snapshot.val();
            if (!offerData || !offerData.sdp || !isCurrentPeerConnection(peerId, peerConnection) || handlingOffer) return;

            const state = peerConnection.signalingState;
            if (state === 'stable') {
                // [TASK A] Offer 処理が失敗しても handlingOffer を必ず解除する
                handlingOffer = true;
                try {
                    await answerRemoteOffer(offerData, false);
                } finally {
                    handlingOffer = false;
                }
                return;
            }

            if (state === 'have-local-offer') {
                if (!polite) {
                    console.log('Glare detected: keeping local offer for', peerId);
                    return;
                }

                handlingOffer = true;
                let recreatePeerConnection = false;
                try {
                    try {
                        console.log('[RTC] setLocalDescription(rollback)開始:', peerId);
                        await peerConnection.setLocalDescription({ type: 'rollback' });
                        console.log('[RTC] setLocalDescription(rollback)成功:', peerId);
                    } catch (error) {
                        console.warn('Rollback unsupported or failed, recreating PeerConnection', error);
                        // 古い pc を map から外して handler を無効化してから置き換える
                        if (peerConnections.get(peerId) === peerConnection) {
                            peerConnection.onicecandidate = null;
                            cleanupPeer(peerId);
                            peerConnections.delete(peerId);
                            try { peerConnection.close(); } catch (closeError) { /* noop */ }
                        }
                        recreatePeerConnection = true;
                    }
                    if (!recreatePeerConnection) await answerRemoteOffer(offerData, true);
                } finally {
                    // [TASK A] rollback / answer のいずれが失敗しても状態を解除する
                    handlingOffer = false;
                }
                if (recreatePeerConnection) {
                    await createPeerConnection(peerId, false);
                    return;
                }
            }
        });

        // リモートピアからの Answer を監視
        const remoteAnswerRef = ref(database, `answers/${peerId}/${localPeerId}`);
        const remoteAnswerUnsub = firebaseOnValue(remoteAnswerRef, `answers/${peerId}/${localPeerId}`, async (snapshot) => {
            const answerData = snapshot.val();
            if (!answerData || !isCurrentPeerConnection(peerId, peerConnection)) return;
            const state = peerConnection.signalingState;
            if (state === 'have-local-offer' || state === 'have-local-pranswer') {
                try {
                    console.log('[RTC] setRemoteDescription(answer)開始:', peerId);
                    await peerConnection.setRemoteDescription({ type: 'answer', sdp: answerData.sdp });
                    console.log('[RTC] setRemoteDescription(answer)成功:', peerId);
                    await flushPendingIce();
                } catch (err) {
                    logError('[RTC] Answer処理失敗', err);
                }
            } else {
                console.warn('Ignoring remote answer because signalingState is', state);
            }
        });

        // リモートピアからの ICE候補を監視
        const remoteCandidatesRef = ref(database, `iceCandidates/${peerId}/${localPeerId}`);
        const remoteCandidatesUnsub = firebaseOnValue(remoteCandidatesRef, `iceCandidates/${peerId}/${localPeerId}`, async (snapshot) => {
            if (!isCurrentPeerConnection(peerId, peerConnection)) return;
            const candidates = snapshot.val() || {};
            for (const candidateKey in candidates) {
                // [TASK 4] 60 秒より古い ICE 候補は処理しない
                const timestamp = candidates[candidateKey] && candidates[candidateKey].timestamp;
                if (typeof timestamp === 'number' && Date.now() - timestamp > ICE_TTL) continue;
                await addRemoteIceCandidate(candidateKey, candidates[candidateKey]);
            }
        });

        // [TASK 3] リスナー解除関数を保持して cleanupPeer で呼び出す
        peerListeners.set(peerId, [remoteOfferUnsub, remoteAnswerUnsub, remoteCandidatesUnsub]);

    } catch (error) {
        logError('[RTC] PeerConnection作成失敗', error);
        const failedPeerConnection = peerConnections.get(peerId);
        if (failedPeerConnection) {
            failedPeerConnection.onicecandidate = null;
            cleanupPeer(peerId);
            if (peerConnections.get(peerId) === failedPeerConnection) {
                try { failedPeerConnection.close(); } catch (closeError) { /* noop */ }
                peerConnections.delete(peerId);
            }
        }
        updateStatus(`RTCエラー: ${error.name || 'Error'} ${error.code || ''} ${error.message || error}`, 'error');
    }
}

// [TASK 10] beforeunload では await できないため、endCall はベストエフォートで実行する
// 必要になった場合は navigator.sendBeacon による削除用エンドポイント呼び出しを検討する
window.addEventListener('beforeunload', () => {
    if (isCallActive) {
        endCall();
    }
});

window.onerror = function (message, source, line, column, error) {
    console.error('[GLOBAL] window.onerror:', {
        message: message,
        source: source,
        line: line,
        column: column,
        error: error
    });
    updateStatus(`[GLOBAL] ${message} (${source || ''}:${line || 0}:${column || 0})`, 'error');
    return false;
};

window.onunhandledrejection = function (event) {
    const reason = event && event.reason;
    logError('[GLOBAL] unhandledrejection', reason);
    updateStatus(`[GLOBAL] 未処理Promiseエラー: ${reason && reason.message ? reason.message : reason}`, 'error');
};

logEnvironment();
checkNetwork('https://www.gstatic.com/generate_204');
checkNetwork('https://aj-voice-call-e157e-default-rtdb.firebaseio.com/.json?shallow=true');
checkNetwork('https://aj-voice-call-e157e.firebaseapp.com/');
checkMicrophone();

// 初期化完了
updateStatus('準備完了。「通話開始」をクリック', 'normal');
