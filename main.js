import { initializeApp } from "https://www.gstatic.com/firebasejs/12.17.1/firebase-app.js";
import { getDatabase, ref, set, get, remove, onValue, off, onDisconnect } from "https://www.gstatic.com/firebasejs/12.17.1/firebase-database.js";
// Firebase Authentication
import { getAuth, signInAnonymously, onAuthStateChanged } from "https://www.gstatic.com/firebasejs/12.17.1/firebase-auth.js";

// Firebase 設定
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
const peerNames = new Map();
const peersRef = ref(database, 'peers');
const offersRef = ref(database, 'offers');
const answersRef = ref(database, 'answers');
const iceCandidatesRef = ref(database, 'iceCandidates');
// onDisconnect ハンドルと heartbeat
let onDisconnectHandle = null;
let heartbeatTimer = null;
const PEER_TTL = 30_000; // 表示する最長寿命（ミリ秒）

// マップ：各ピアに紐づくリスナー参照（後で off するため）
const peerListeners = new Map();
// マップ：リモート音声用の audio 要素
const remoteAudios = new Map();

// WebRTC 設定
const peerConnectionConfig = {
    iceServers: [
        { urls: ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302'] }
    ]
};

// UI 要素
const statusEl = document.getElementById('status');
const startBtn = document.getElementById('startBtn');
const endBtn = document.getElementById('endBtn');
const peerListEl = document.getElementById('peerList');
const peersEl = document.getElementById('peers');
const displayNameInput = document.getElementById('displayName');

// イベントリスナー
startBtn.addEventListener('click', startCall);
endBtn.addEventListener('click', endCall);
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

        // 匿名認証
        logStep(3, 'signInAnonymously開始');
        try {
            await signInAnonymously(auth);
            console.log('[FB] signInAnonymously成功');
        } catch (authError) {
            logError('[FB] signInAnonymously失敗', authError);
            // 既に認証済みの場合はエラーになるので無視
            if (authError.code !== 'auth/already-initialized') {
                throw authError;
            }
        }

        const user = auth.currentUser;
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
        logStep(7, `peers/${localPeerId} への set開始`);
        await firebaseSet(myPeerRef, peerRecord(), `peers/${localPeerId}`);
        logStep(8, 'peers set成功');

        // onDisconnect で自動削除（タブ落ち／ブラウザ落ち対策）
        logStep(9, 'onDisconnect設定');
        try {
            onDisconnectHandle = onDisconnect(myPeerRef);
            await onDisconnectHandle.remove();
            console.log('[FB] onDisconnect設定成功:', `peers/${localPeerId}`);
        } catch (e) {
            logError('[FB] onDisconnect設定失敗', e);
            onDisconnectHandle = null;
        }

        // heartbeat（定期的に timestamp を更新）
        logStep(10, 'heartbeat開始');
        heartbeatTimer = setInterval(() => {
            firebaseSet(myPeerRef, peerRecord(), `peers/${localPeerId}`).catch((e) => logError('[FB] heartbeat失敗', e));
        }, 10000); // 10秒ごと

        // 既存の参加者を監視
        logStep(11, 'monitorPeers開始');
        monitorPeers();

        // UI 更新
        startBtn.disabled = true;
        endBtn.disabled = false;
        displayNameInput.disabled = true;
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
        off(peersRef);

        if (heartbeatTimer) {
            clearInterval(heartbeatTimer);
            heartbeatTimer = null;
        }

        // トラック停止より先に PC を閉じ、再ネゴシエーションを起こさない
        for (const peerId of Array.from(peerConnections.keys())) {
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

        if (onDisconnectHandle) {
            try { await onDisconnectHandle.cancel(); } catch (e) { /* ignore */ }
            onDisconnectHandle = null;
        }

        if (localPeerId) {
            await firebaseRemove(ref(database, `peers/${localPeerId}`), `peers/${localPeerId}`);
            await firebaseRemove(ref(database, `offers/${localPeerId}`), `offers/${localPeerId}`);
            await firebaseRemove(ref(database, `answers/${localPeerId}`), `answers/${localPeerId}`);
            await firebaseRemove(ref(database, `iceCandidates/${localPeerId}`), `iceCandidates/${localPeerId}`);
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
    // オフライン/切断時に各種リスナーを解除
    const refs = peerListeners.get(peerId);
    if (refs) {
        for (const r of refs) {
            try { off(r); } catch (e) { /* noop */ }
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
}

function isCurrentPeerConnection(peerId, peerConnection) {
    return isCallActive && peerConnections.get(peerId) === peerConnection;
}

async function monitorPeers() {
    firebaseOnValue(peersRef, 'peers', async (snapshot) => {
        if (!isCallActive) return;

        const peers = snapshot.val() || {};
        // 自分以外で、かつ最近更新されたピアだけ表示する（PEER_TTL を参照）
        const peerIds = Object.entries(peers)
          .filter(([id, data]) => id !== localPeerId && (Date.now() - (data.timestamp || 0) < PEER_TTL))
          .map(([id, data]) => {
            peerNames.set(id, normalizeDisplayName(data && data.name) || id.slice(0, 8));
            return id;
          });

        // 接続していない新しいピアに接続
        for (const peerId of peerIds) {
            if (!isCallActive) return;
            if (!peerConnections.has(peerId)) {
                // deterministic initiator: 比較で一方のみ initiator=true にする
                const initiator = localPeerId > peerId;
                await createPeerConnection(peerId, initiator);
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

        // UI 更新
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
        const nameEl = document.createElement('span');
        nameEl.textContent = peerNames.get(peerId) || peerId.slice(0, 8);
        const connectionStatusEl = document.createElement('span');
        connectionStatusEl.className = 'peer-status';
        connectionStatusEl.textContent = status;
        item.append(nameEl, connectionStatusEl);
        peersEl.appendChild(item);
    }
}

async function createPeerConnection(peerId, initiator) {
    try {
        if (!isCallActive || !localPeerId) return;

        console.log('[RTC] createPeerConnection:', 'peerId=', peerId, 'initiator=', initiator);
        const peerConnection = new RTCPeerConnection(peerConnectionConfig);
        peerConnections.set(peerId, peerConnection);
        const pendingIce = [];
        const appliedIceKeys = new Set();

        // ローカルストリーム追加
        if (localStream) {
            localStream.getTracks().forEach(track => {
                peerConnection.addTrack(track, localStream);
            });
        }

        async function addRemoteIceCandidate(candidateKey, candidateData) {
            if (!isCurrentPeerConnection(peerId, peerConnection)) return;
            if (appliedIceKeys.has(candidateKey)) return;
            const ice = {
                candidate: candidateData.candidate,
                sdpMLineIndex: candidateData.sdpMLineIndex,
                sdpMid: candidateData.sdpMid
            };
            if (!peerConnection.remoteDescription) {
                pendingIce.push([candidateKey, ice]);
                return;
            }
            appliedIceKeys.add(candidateKey);
            try {
                await peerConnection.addIceCandidate(ice);
            } catch (error) {
                if (peerConnection.signalingState !== 'closed') {
                    logError(`[RTC] ICE候補追加失敗: peerId=${peerId}`, error);
                }
            }
        }

        async function flushPendingIce() {
            const queued = pendingIce.splice(0);
            for (const [candidateKey, ice] of queued) {
                await addRemoteIceCandidate(candidateKey, ice);
            }
        }

        // ICE候補を処理
        peerConnection.onicecandidate = (event) => {
            peerConnection.iceCandidateEventCount = (peerConnection.iceCandidateEventCount || 0) + 1;
            console.log('[RTC] onicecandidate:', 'peerId=', peerId, 'count=', peerConnection.iceCandidateEventCount, 'hasCandidate=', !!event.candidate);
            
            if (!event.candidate) return;
            if (!isCurrentPeerConnection(peerId, peerConnection) || !localPeerId) return;
            const candidateKey = Math.random().toString(36).slice(2);
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
                audioEl.style.display = 'none';
                document.body.appendChild(audioEl);
                remoteAudios.set(peerId, audioEl);
            }
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

            if (!isCurrentPeerConnection(peerId, peerConnection) || !localPeerId) return;

            await firebaseSet(ref(database, `offers/${localPeerId}/${peerId}`), {
                sdp: offer.sdp,
                type: 'offer',
                timestamp: Date.now()
            }, `offers/${localPeerId}/${peerId}`);
        }

        // リモートピアからの Offer を監視
        const remoteOfferRef = ref(database, `offers/${peerId}/${localPeerId}`);
        firebaseOnValue(remoteOfferRef, `offers/${peerId}/${localPeerId}`, async (snapshot) => {
            const offerData = snapshot.val();
            if (!offerData || !isCurrentPeerConnection(peerId, peerConnection)) return;

            const state = peerConnection.signalingState;
            if (state === 'stable') {
                try {
                    console.log('[RTC] setRemoteDescription(offer)開始:', peerId);
                    await peerConnection.setRemoteDescription({ type: 'offer', sdp: offerData.sdp });
                    console.log('[RTC] setRemoteDescription(offer)成功:', peerId);
                    await flushPendingIce();
                    console.log('[RTC] createAnswer開始:', peerId);
                    const answer = await peerConnection.createAnswer();
                    console.log('[RTC] createAnswer成功:', peerId);
                    console.log('[RTC] setLocalDescription(answer)開始:', peerId);
                    await peerConnection.setLocalDescription(answer);
                    console.log('[RTC] setLocalDescription(answer)成功:', peerId);
                    if (!isCurrentPeerConnection(peerId, peerConnection) || !localPeerId) return;
                    await firebaseSet(ref(database, `answers/${localPeerId}/${peerId}`), {
                        sdp: answer.sdp,
                        type: 'answer',
                        timestamp: Date.now()
                    }, `answers/${localPeerId}/${peerId}`);
                } catch (err) {
                    logError('[RTC] Offer処理失敗', err);
                }
                return;
            }

            if (state === 'have-local-offer') {
                if (localPeerId > peerId) {
                    console.log('Glare detected: keeping local offer for', peerId);
                    return;
                } else {
                    try {
                        console.log('[RTC] setLocalDescription(rollback)開始:', peerId);
                        await peerConnection.setLocalDescription({ type: 'rollback' });
                        console.log('[RTC] setLocalDescription(rollback)成功:', peerId);
                    } catch (e) {
                        console.warn('Rollback unsupported or failed, recreating PeerConnection', e);
                        cleanupPeer(peerId);
                        const pc = peerConnections.get(peerId);
                        if (pc) {
                            try { pc.close(); } catch (e) { /* noop */ }
                            peerConnections.delete(peerId);
                        }
                        await createPeerConnection(peerId, false);
                        return;
                    }
                    try {
                        console.log('[RTC] glare setRemoteDescription(offer)開始:', peerId);
                        await peerConnection.setRemoteDescription({ type: 'offer', sdp: offerData.sdp });
                        console.log('[RTC] glare setRemoteDescription(offer)成功:', peerId);
                        await flushPendingIce();
                        console.log('[RTC] glare createAnswer開始:', peerId);
                        const answer = await peerConnection.createAnswer();
                        console.log('[RTC] glare createAnswer成功:', peerId);
                        console.log('[RTC] glare setLocalDescription(answer)開始:', peerId);
                        await peerConnection.setLocalDescription(answer);
                        console.log('[RTC] glare setLocalDescription(answer)成功:', peerId);
                        if (!isCurrentPeerConnection(peerId, peerConnection) || !localPeerId) return;
                        await firebaseSet(ref(database, `answers/${localPeerId}/${peerId}`), {
                            sdp: answer.sdp,
                            type: 'answer',
                            timestamp: Date.now()
                        }, `answers/${localPeerId}/${peerId}`);
                    } catch (err) {
                        logError('[RTC] Glare Offer処理失敗', err);
                    }
                }
            }
        });

        // リモートピアからの Answer を監視
        const remoteAnswerRef = ref(database, `answers/${peerId}/${localPeerId}`);
        firebaseOnValue(remoteAnswerRef, `answers/${peerId}/${localPeerId}`, async (snapshot) => {
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
        firebaseOnValue(remoteCandidatesRef, `iceCandidates/${peerId}/${localPeerId}`, async (snapshot) => {
            if (!isCurrentPeerConnection(peerId, peerConnection)) return;
            const candidates = snapshot.val() || {};
            for (const candidateKey in candidates) {
                await addRemoteIceCandidate(candidateKey, candidates[candidateKey]);
            }
        });

        // リスナー参照を保持（終了時に off する）
        peerListeners.set(peerId, [remoteOfferRef, remoteAnswerRef, remoteCandidatesRef]);

    } catch (error) {
        logError('[RTC] PeerConnection作成失敗', error);
        updateStatus(`RTCエラー: ${error.name || 'Error'} ${error.code || ''} ${error.message || error}`, 'error');
    }
}

// ページ離脱時に通話を終了
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
