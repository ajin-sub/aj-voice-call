import { initializeApp } from "https://www.gstatic.com/firebasejs/12.17.1/firebase-app.js";
import { getDatabase, ref, set, get, remove, onValue, off, onDisconnect } from "https://www.gstatic.com/firebasejs/12.17.1/firebase-database.js";

// Firebase 設定
const firebaseConfig = {
    apiKey: "AIzaSyBgwdi7XhnG-bYn2hwAfO-s3n92ky_9eMo",
    authDomain: "aj-voice-call-e157e.firebaseapp.com",
    databaseURL: "https://aj-voice-call-e157e-default-rtdb.firebaseio.com",
    projectId: "aj-voice-call-e157e",
    storageBucket: "aj-voice-call-e157e.firebasestorage.app",
    messagingSenderId: "332396481182",
    appId: "1:332396481182:web:5482f3b68cd83544b2c98f",
    measurementId: "G-4EDK28K1PS"
};

// Firebase 初期化
const app = initializeApp(firebaseConfig);
const database = getDatabase(app);

// グローバル変数
let localStream = null;
let peerConnections = new Map();
let localPeerId = null;
let localDisplayName = '';
let isCallActive = false;
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

function generatePeerId() {
    if (typeof crypto !== 'undefined' && crypto.randomUUID) {
        return 'peer_' + crypto.randomUUID();
    }
    return 'peer_' + Math.random().toString(36).slice(2, 11);
}

function updateStatus(message, type = 'normal') {
    statusEl.textContent = message;
    statusEl.className = `status ${type}`;
    console.log(`[${type.toUpperCase()}] ${message}`);
}

async function startCall() {
    try {
        const name = normalizeDisplayName(displayNameInput.value);
        if (!name) {
            updateStatus('参加する前に表示名を入力してください', 'error');
            displayNameInput.focus();
            return;
        }
        localDisplayName = name;
        displayNameInput.value = name;

        updateStatus('マイクへのアクセスを許可してください...', 'connecting');

        // マイクストリーム取得
        localStream = await navigator.mediaDevices.getUserMedia({
            audio: {
                echoCancellation: true,
                noiseSuppression: true,
                autoGainControl: true
            },
            video: false
        });

        isCallActive = true;
        localPeerId = generatePeerId();
        updateStatus('通話ルームに参加中...', 'connecting');

// Firebase に自分の情報を登録（myPeerRef を作る）
const myPeerRef = ref(database, `peers/${localPeerId}`);
await set(myPeerRef, peerRecord());

// onDisconnect で自動削除（タブ落ち／ブラウザ落ち対策）
try {
  onDisconnectHandle = onDisconnect(myPeerRef);
  await onDisconnectHandle.remove();
} catch (e) {
  console.warn('onDisconnect setup failed', e);
  onDisconnectHandle = null;
}

// heartbeat（定期的に timestamp を更新）
heartbeatTimer = setInterval(() => {
  set(myPeerRef, peerRecord()).catch(e => console.warn('heartbeat failed', e));
}, 10000); // 10秒ごと

        // 既存の参加者を監視
        monitorPeers();

        // UI 更新
        startBtn.disabled = true;
        endBtn.disabled = false;
        displayNameInput.disabled = true;
        updateStatus('通話待機中...接続を待っています', 'connected');

    } catch (error) {
        console.error('エラー:', error);
        localDisplayName = '';
        displayNameInput.disabled = false;
        updateStatus(`エラー: ${error.message}`, 'error');
    }
}

async function endCall() {
    try {
        updateStatus('通話を終了中...', 'connecting');

        // 自分を peers から消す前に監視を止める。
        // そうしないと「相手はまだ残っている」スナップショットで再接続してしまう。
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
            await remove(ref(database, `peers/${localPeerId}`));
            await remove(ref(database, `offers/${localPeerId}`));
            await remove(ref(database, `answers/${localPeerId}`));
            await remove(ref(database, `iceCandidates/${localPeerId}`));
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
        console.error('エラー:', error);
        updateStatus(`エラー: ${error.message}`, 'error');
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
    onValue(peersRef, async (snapshot) => {
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
                await createPeerConnection(peerId, initiator); // initiator may be true/false
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
                    console.error('ICE候補追加エラー:', error);
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
            if (!event.candidate) return;
            if (!isCurrentPeerConnection(peerId, peerConnection) || !localPeerId) return;
            const candidateKey = Math.random().toString(36).slice(2);
            set(ref(database, `iceCandidates/${localPeerId}/${peerId}/${candidateKey}`), {
                candidate: event.candidate.candidate,
                sdpMLineIndex: event.candidate.sdpMLineIndex,
                sdpMid: event.candidate.sdpMid,
                timestamp: Date.now()
            });
        };

        // リモートストリームを受け取る
        peerConnection.ontrack = (event) => {
            console.log('リモートストリーム受信:', peerId);
            // audio 要素を作成して再生
            let audioEl = remoteAudios.get(peerId);
            if (!audioEl) {
                audioEl = document.createElement('audio');
                audioEl.autoplay = true;
                audioEl.controls = false;
                audioEl.style.display = 'none';
                document.body.appendChild(audioEl);
                remoteAudios.set(peerId, audioEl);
            }
            // 一般的には event.streams[0] に音声が含まれる
            if (event.streams && event.streams[0]) {
                audioEl.srcObject = event.streams[0];
            }
        };

        // 接続状態の変化を監視
        peerConnection.onconnectionstatechange = () => {
            if (!isCurrentPeerConnection(peerId, peerConnection)) return;
            console.log(`ピア ${peerId} の接続状態: ${peerConnection.connectionState}`);
            updatePeerList(Array.from(peerConnections.keys()));
            if (peerConnection.connectionState === 'failed' || peerConnection.connectionState === 'closed') {
                cleanupPeer(peerId);
                if (peerConnections.get(peerId) === peerConnection) {
                    try { peerConnection.close(); } catch (e) { /* noop */ }
                    peerConnections.delete(peerId);
                }
            }
        };

        if (initiator) {
            // Offer を作成して送信
            const offer = await peerConnection.createOffer();
            if (!isCurrentPeerConnection(peerId, peerConnection)) return;
            await peerConnection.setLocalDescription(offer);
            if (!isCurrentPeerConnection(peerId, peerConnection) || !localPeerId) return;
            await set(ref(database, `offers/${localPeerId}/${peerId}`), {
                sdp: offer.sdp,
                type: 'offer',
                timestamp: Date.now()
            });
        }

        // リモートピアからの Offer を監視
        const remoteOfferRef = ref(database, `offers/${peerId}/${localPeerId}`);
        onValue(remoteOfferRef, async (snapshot) => {
            const offerData = snapshot.val();
            if (!offerData || !isCurrentPeerConnection(peerId, peerConnection)) return;

            const state = peerConnection.signalingState;
            // 普通のケース: stable -> setRemote + createAnswer
            if (state === 'stable') {
                try {
                    await peerConnection.setRemoteDescription({ type: 'offer', sdp: offerData.sdp });
                    await flushPendingIce();
                    const answer = await peerConnection.createAnswer();
                    await peerConnection.setLocalDescription(answer);
                    if (!isCurrentPeerConnection(peerId, peerConnection) || !localPeerId) return;
                    await set(ref(database, `answers/${localPeerId}/${peerId}`), {
                        sdp: answer.sdp,
                        type: 'answer',
                        timestamp: Date.now()
                    });
                } catch (err) {
                    console.error('Offer 処理エラー:', err);
                }
                return;
            }

            // glare: 自分が既にローカルオファーを出している場合
            if (state === 'have-local-offer') {
                // tie-breaker: localPeerId > peerId の一致したルールで決定
                if (localPeerId > peerId) {
                    // 自分のオファーを保持してリモートオファーを無視
                    console.log('Glare detected: keeping local offer for', peerId);
                    return;
                } else {
                    // 相手のオファーを受け入れる — rollback を試みる
                    try {
                        await peerConnection.setLocalDescription({ type: 'rollback' });
                    } catch (e) {
                        console.warn('Rollback unsupported or failed, recreating PeerConnection', e);
                        // フォールバック: 現在の接続を破棄して再作成
                        cleanupPeer(peerId);
                        const pc = peerConnections.get(peerId);
                        if (pc) {
                            try { pc.close(); } catch (e) { /* noop */ }
                            peerConnections.delete(peerId);
                        }
                        // 再作成して受け入れ側として処理
                        await createPeerConnection(peerId, false);
                        return;
                    }
                    try {
                        await peerConnection.setRemoteDescription({ type: 'offer', sdp: offerData.sdp });
                        await flushPendingIce();
                        const answer = await peerConnection.createAnswer();
                        await peerConnection.setLocalDescription(answer);
                        if (!isCurrentPeerConnection(peerId, peerConnection) || !localPeerId) return;
                        await set(ref(database, `answers/${localPeerId}/${peerId}`), {
                            sdp: answer.sdp,
                            type: 'answer',
                            timestamp: Date.now()
                        });
                    } catch (err) {
                        console.error('Glare Offer 処理エラー:', err);
                    }
                }
            }
        });

        // リモートピアからの Answer を監視
        const remoteAnswerRef = ref(database, `answers/${peerId}/${localPeerId}`);
        onValue(remoteAnswerRef, async (snapshot) => {
            const answerData = snapshot.val();
            if (!answerData || !isCurrentPeerConnection(peerId, peerConnection)) return;
            const state = peerConnection.signalingState;
            if (state === 'have-local-offer' || state === 'have-local-pranswer') {
                try {
                    await peerConnection.setRemoteDescription({ type: 'answer', sdp: answerData.sdp });
                    await flushPendingIce();
                } catch (err) {
                    console.error('Answer 処理エラー:', err);
                }
            } else {
                console.warn('Ignoring remote answer because signalingState is', state);
            }
        });

        // リモートピアからの ICE候補を監視
        const remoteCandidatesRef = ref(database, `iceCandidates/${peerId}/${localPeerId}`);
        onValue(remoteCandidatesRef, async (snapshot) => {
            if (!isCurrentPeerConnection(peerId, peerConnection)) return;
            const candidates = snapshot.val() || {};
            for (const candidateKey in candidates) {
                await addRemoteIceCandidate(candidateKey, candidates[candidateKey]);
            }
        });

        // リスナー参照を保持（終了時に off する）
        peerListeners.set(peerId, [remoteOfferRef, remoteAnswerRef, remoteCandidatesRef]);

    } catch (error) {
        console.error('PeerConnection 作成エラー:', error);
        updateStatus(`エラー: ${error.message}`, 'error');
    }
}

// ページ離脱時に通話を終了
window.addEventListener('beforeunload', () => {
    if (isCallActive) {
        // 非同期処理は完了を保証できないため fire-and-forget
        endCall();
    }
});

// 初期化完了
updateStatus('準備完了。「通話開始」をクリック', 'normal');
