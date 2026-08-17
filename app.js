// Pulse — Decentralized Engine v1.0 (GitHub Pages Optimized)
const RELAYS = ['wss://relay.damus.io', 'wss://relay.primal.net', 'wss://nos.lol'];
const APP_TAG = 'pulse-platform';

// ── 1. Identity Management ──
let skBytes, pk, npub;
const storageKey = 'pulse_nsec_hex';

function initIdentity() {
    let hexSk = localStorage.getItem(storageKey);
    if (!hexSk) {
        const newSk = NostrTools.generateSecretKey();
        hexSk = NostrTools.utils.bytesToHex(newSk);
        localStorage.setItem(storageKey, hexSk);
    }
    skBytes = NostrTools.utils.hexToBytes(hexSk);
    pk = NostrTools.getPublicKey(skBytes);
    npub = NostrTools.nip19.npubEncode(pk);
    
    document.getElementById('npub-display').textContent = npub.slice(0, 8) + '...' + npub.slice(-6);
}

// ── 2. Nostr Pool & Feed ──
const pool = new NostrTools.SimplePool();
const seenEvents = new Set();

function startFeed() {
    document.getElementById('loading-feed').classList.remove('hidden');
    pool.subscribeMany(
        RELAYS,
        [{ kinds: [1], limit: 30 }],
        {
            onevent: (event) => {
                if (seenEvents.has(event.id)) return;
                seenEvents.add(event.id);
                renderPost(event);
            },
            oneose: () => {
                document.getElementById('loading-feed').classList.add('hidden');
            }
        }
    );
}

function renderPost(event) {
    const container = document.getElementById('feed-container');
    const shortPubkey = event.pubkey.slice(0, 6);
    const time = new Date(event.created_at * 1000).toLocaleTimeString('ar-EG', {hour: '2-digit', minute:'2-digit'});
    
    const div = document.createElement('div');
    div.className = 'bg-white dark:bg-surface rounded-2xl p-4 shadow-sm border border-gray-100 dark:border-gray-800 fade-in';
    div.innerHTML = `
        <div class="flex justify-between items-start mb-3">
            <div class="flex items-center gap-3">
                <div class="avatar w-10 h-10 bg-indigo-500 text-sm">${shortPubkey}</div>
                <div>
                    <div class="font-bold text-sm dark:text-white">${shortPubkey}...</div>
                    <div class="text-xs text-gray-400">${time}</div>
                </div>
            </div>
        </div>
        <p class="text-gray-800 dark:text-gray-200 leading-relaxed mb-4 whitespace-pre-wrap text-sm md:text-base">${escapeHtml(event.content)}</p>
        <div class="flex items-center gap-6 text-gray-400 text-sm border-t border-gray-100 dark:border-gray-800 pt-3">
            <button onclick="likePost('${event.id}', '${event.pubkey}')" class="flex items-center gap-2 hover:text-red-500 transition">
                <i class="far fa-heart"></i> <span>إعجاب</span>
            </button>
            <button onclick="replyToPost('${event.id}', '${event.pubkey}')" class="flex items-center gap-2 hover:text-blue-500 transition">
                <i class="far fa-comment"></i> <span>رد</span>
            </button>
        </div>
    `;
    container.prepend(div);
}

// ── 3. Actions (Publish, Like, Reply) ──
async function publishPost() {
    const input = document.getElementById('post-input');
    const content = input.value.trim();
    if (!content) return;

    const eventTemplate = {
        kind: 1,
        created_at: Math.floor(Date.now() / 1000),
        tags: [['t', APP_TAG]],
        content: content
    };
    
    const signedEvent = NostrTools.finalizeEvent(eventTemplate, skBytes);
    await pool.publish(RELAYS, signedEvent);
    
    input.value = '';
    showToast('تم النشر بنجاح على شبكة Nostr');
}

async function likePost(targetId, targetPubkey) {
    const eventTemplate = {
        kind: 7,
        created_at: Math.floor(Date.now() / 1000),
        tags: [['e', targetId], ['p', targetPubkey]],
        content: '+'
    };
    const signedEvent = NostrTools.finalizeEvent(eventTemplate, skBytes);
    await pool.publish(RELAYS, signedEvent);
    showToast('تم الإعجاب بالمنشور');
}

async function replyToPost(targetId, targetPubkey) {
    const content = prompt('اكتب ردك:');
    if (!content) return;
    
    const eventTemplate = {
        kind: 1,
        created_at: Math.floor(Date.now() / 1000),
        tags: [['e', targetId, '', 'reply'], ['p', targetPubkey]],
        content: content
    };
    const signedEvent = NostrTools.finalizeEvent(eventTemplate, skBytes);
    await pool.publish(RELAYS, signedEvent);
    showToast('تم إرسال الرد');
}

// ── 4. Voice Rooms (WebRTC + Nostr Signaling) ──
let localStream = null;
let peer = null;
let currentRoom = null;
let roomSub = null;
let isMuted = false;

async function toggleRoom() {
    const btn = document.getElementById('btn-join-room');
    const input = document.getElementById('room-input');
    const activeUi = document.getElementById('active-room-ui');

    if (!currentRoom) {
        currentRoom = input.value.trim() || 'general';
        try {
            localStream = await navigator.mediaDevices.getUserMedia({ audio: true });
        } catch (e) {
            showToast('يرجى السماح باستخدام المايكروفون', 'error');
            return;
        }

        const myPeerId = npub.slice(0, 10).replace('npub1', 'p');
        peer = new Peer(myPeerId);
        
        peer.on('open', () => {
            announcePresence(myPeerId);
            listenForPeers();
        });

        peer.on('call', (call) => {
            call.answer(localStream);
            call.on('stream', (remoteStream) => {
                addPeerAudio(remoteStream, 'مستمع');
            });
        });

        document.getElementById('current-room-name').textContent = `غرفة: ${currentRoom}`;
        activeUi.classList.remove('hidden');
        btn.textContent = 'مغادرة';
        btn.classList.add('bg-red-500', 'text-white');
        btn.classList.remove('bg-white', 'text-accent');
    } else {
        if (roomSub) roomSub.close();
        if (peer) peer.destroy();
        if (localStream) localStream.getTracks().forEach(t => t.stop());
        
        currentRoom = null;
        activeUi.classList.add('hidden');
        document.getElementById('peers-list').innerHTML = '';
        btn.textContent = 'دخول';
        btn.classList.remove('bg-red-500', 'text-white');
        btn.classList.add('bg-white', 'text-accent');
    }
}

function announcePresence(myPeerId) {
    const eventTemplate = {
        kind: 1,
        created_at: Math.floor(Date.now() / 1000),
        tags: [['t', 'pulse-room'], ['room', currentRoom]],
        content: JSON.stringify({ peerId: myPeerId, npub: npub.slice(0,8) })
    };
    const signedEvent = NostrTools.finalizeEvent(eventTemplate, skBytes);
    pool.publish(RELAYS, signedEvent);
}

function listenForPeers() {
    roomSub = pool.subscribeMany(
        RELAYS,
        [{ kinds: [1], '#room': [currentRoom], limit: 10 }],
        {
            onevent: (event) => {
                if (event.pubkey === pk) return;
                try {
                    const data = JSON.parse(event.content);
                    if (data.peerId && !document.getElementById(`peer-${data.peerId}`)) {
                        connectToPeer(data.peerId, data.npub);
                    }
                } catch(e) {}
            }
        }
    );
}

function connectToPeer(targetPeerId, displayName) {
    const call = peer.call(targetPeerId, localStream);
    call.on('stream', (remoteStream) => {
        addPeerAudio(remoteStream, displayName);
    });
}

function addPeerAudio(stream, name) {
    const audio = document.createElement('audio');
    audio.srcObject = stream;
    audio.autoplay = true;
    audio.id = `audio-${name}`;
    
    const div = document.createElement('div');
    div.id = `peer-${name}`;
    div.className = 'flex items-center gap-2 bg-gray-50 dark:bg-gray-800 p-2 rounded-lg';
    div.innerHTML = `<div class="w-2 h-2 bg-green-500 rounded-full animate-pulse"></div> <span>${name}</span>`;
    
    document.getElementById('peers-list').appendChild(div);
    document.body.appendChild(audio);
}

function toggleMute() {
    isMuted = !isMuted;
    localStream.getAudioTracks().forEach(t => t.enabled = !isMuted);
    const btn = document.getElementById('btn-mute');
    btn.innerHTML = isMuted ? '<i class="fas fa-microphone-slash text-red-500"></i>' : '<i class="fas fa-microphone"></i>';
    btn.classList.toggle('bg-red-100', isMuted);
    btn.classList.toggle('text-red-500', isMuted);
}

// ── 5. UI Utilities ──
function switchView(viewName) {
    document.querySelectorAll('.view-section').forEach(el => el.classList.add('hidden'));
    document.getElementById(`view-${viewName}`).classList.remove('hidden');
    
    document.querySelectorAll('.nav-btn').forEach(el => {
        el.classList.remove('text-accent', 'active');
        el.classList.add('text-gray-400');
    });
    const activeBtn = document.getElementById(`nav-${viewName}`);
    activeBtn.classList.add('text-accent', 'active');
    activeBtn.classList.remove('text-gray-400');
}

function toggleTheme() {
    document.documentElement.classList.toggle('dark');
    localStorage.setItem('theme', document.documentElement.classList.contains('dark') ? 'dark' : 'light');
}

function showToast(msg, type = 'success') {
    const toast = document.getElementById('toast');
    const icon = toast.querySelector('i');
    document.getElementById('toast-msg').textContent = msg;
    
    if (type === 'error') {
        icon.className = 'fas fa-exclamation-circle text-red-400';
    } else {
        icon.className = 'fas fa-check-circle text-green-400';
    }
    
    toast.classList.remove('hidden');
    setTimeout(() => toast.classList.add('hidden'), 3000);
}

function escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
}

// ── 6. Boot ──
document.addEventListener('DOMContentLoaded', () => {
    if (localStorage.getItem('theme') === 'dark' || (!localStorage.getItem('theme') && window.matchMedia('(prefers-color-scheme: dark)').matches)) {
        document.documentElement.classList.add('dark');
    }
    initIdentity();
    startFeed();
});

// ── 7. PWA Service Worker Registration (GitHub Pages Safe) ──
if ('serviceWorker' in navigator) {
    window.addEventListener('load', () => {
        navigator.serviceWorker.register('./sw.js')
            .then(registration => {
                console.log('✅ Service Worker registered with scope:', registration.scope);
            })
            .catch(error => {
                console.log('❌ Service Worker registration failed:', error);
            });
    });
}
