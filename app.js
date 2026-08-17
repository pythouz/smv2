const RELAYS = ['wss://relay.damus.io', 'wss://relay.primal.net', 'wss://nos.lol'];
const APP_TAG = 'pulse-platform';

let skBytes, pk, npub;
const storageKey = 'pulse_nsec_hex';

// 1. تهيئة الهوية مع إصلاح تلقائي للأخطاء
function initIdentity() {
    try {
        let hexSk = localStorage.getItem(storageKey);
        
        // إذا لم يوجد مفتاح أو كان طوله غير صحيح (يجب أن يكون 64 حرفاً)
        if (!hexSk || hexSk.length !== 64) {
            console.log("Generating new secure identity...");
            const newSk = NostrTools.generateSecretKey();
            hexSk = NostrTools.utils.bytesToHex(newSk);
            localStorage.setItem(storageKey, hexSk);
        }
        
        skBytes = NostrTools.utils.hexToBytes(hexSk);
        
        // تحقق أمني إضافي للتأكد من أن المفتاح 32 بايت
        if (!skBytes || skBytes.length !== 32) {
            throw new Error("Invalid key length");
        }

        pk = NostrTools.getPublicKey(skBytes);
        npub = NostrTools.nip19.npubEncode(pk);
        document.getElementById('npub-display').textContent = npub.slice(0, 8) + '...' + npub.slice(-6);
        
    } catch (err) {
        console.error("Identity Error:", err);
        // الحل الجذري: مسح المفتاح التالف وإعادة المحاولة
        localStorage.removeItem(storageKey);
        initIdentity();
    }
}

const pool = new NostrTools.SimplePool();
const seenEvents = new Set();

function startFeed() {
    document.getElementById('loading-feed').classList.remove('hidden');
    pool.subscribeMany(
        RELAYS,
        [{ kinds: [1], '#t': [APP_TAG], limit: 30 }],
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
    div.className = 'post-card bg-white dark:bg-surface rounded-2xl p-4 shadow-sm border border-gray-100 dark:border-gray-800 fade-in';
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

async function publishPost() {
    const input = document.getElementById('post-input');
    const content = input.value.trim();
    if (!content) return;

    try {
        // تحقق نهائي قبل النشر
        if (!skBytes || skBytes.length !== 32) {
            throw new Error("المفتاح السري غير صالح، جاري إعادة التهيئة...");
        }

        const eventTemplate = {
            kind: 1,
            created_at: Math.floor(Date.now() / 1000),
            tags: [['t', APP_TAG]],
            content: content
        };
        
        const signedEvent = NostrTools.finalizeEvent(eventTemplate, skBytes);
        showToast('جاري النشر...', 'info');
        const results = await pool.publish(RELAYS, signedEvent);
        
        const successCount = Object.values(results).filter(r => r).length;
        if (successCount > 0) {
            input.value = '';
            showToast('تم النشر بنجاح في مجتمعك', 'success');
        } else {
            showToast('فشل النشر: الخوادم لم تستجب', 'error');
        }
    } catch (err) {
        console.error("Publish Error:", err);
        showToast(err.message.includes('غير صالح') ? err.message : 'فشل النشر: ' + err.message, 'error');
        // محاولة إصلاح ذاتي إذا فشل النشر بسبب المفتاح
        if (err.message.includes('undefined') || err.message.includes('32 bytes')) {
            localStorage.removeItem(storageKey);
            initIdentity();
            showToast('تم إصلاح الهوية، حاول النشر مرة أخرى', 'info');
        }
    }
}

async function likePost(targetId, targetPubkey) {
    try {
        const eventTemplate = {
            kind: 7,
            created_at: Math.floor(Date.now() / 1000),
            tags: [['e', targetId], ['p', targetPubkey]],
            content: '+'
        };
        const signedEvent = NostrTools.finalizeEvent(eventTemplate, skBytes);
        await pool.publish(RELAYS, signedEvent);
        showToast('تم الإعجاب', 'success');
    } catch (err) {
        showToast('فشل الإعجاب', 'error');
    }
}

async function replyToPost(targetId, targetPubkey) {
    const content = prompt('اكتب ردك:');
    if (!content) return;
    
    try {
        const eventTemplate = {
            kind: 1,
            created_at: Math.floor(Date.now() / 1000),
            tags: [['e', targetId, '', 'reply'], ['p', targetPubkey], ['t', APP_TAG]],
            content: content
        };
        const signedEvent = NostrTools.finalizeEvent(eventTemplate, skBytes);
        await pool.publish(RELAYS, signedEvent);
        showToast('تم إرسال الرد', 'success');
    } catch (err) {
        showToast('فشل إرسال الرد', 'error');
    }
}

// ── Voice Rooms Logic (مع حفظ الحالة عند الـ Refresh) ──
let localStream = null;
let peer = null;
let currentRoom = null;
let roomSub = null;
let isMuted = false;

async function toggleRoom(forceLeave = false) {
    const btn = document.getElementById('btn-join-room');
    const input = document.getElementById('room-input');
    const activeUi = document.getElementById('active-room-ui');

    if (!currentRoom || forceLeave) {
        // مغادرة الغرفة
        if (roomSub) roomSub.close();
        if (peer) peer.destroy();
        if (localStream) localStream.getTracks().forEach(t => t.stop());
        
        currentRoom = null;
        localStorage.removeItem('active_room'); // مسح الحالة
        activeUi.classList.add('hidden');
        document.getElementById('peers-list').innerHTML = '';
        btn.textContent = 'دخول';
        btn.classList.remove('bg-red-500', 'text-white');
        btn.classList.add('bg-white', 'text-accent');
        input.disabled = false;
        return;
    }

    // الدخول للغرفة
    try {
        localStream = await navigator.mediaDevices.getUserMedia({ 
            audio: { echoCancellation: true, noiseSuppression: true } 
        });
    } catch (e) {
        console.error("Mic Error:", e);
        showToast('يرجى السماح باستخدام المايكروفون من إعدادات المتصفح', 'error');
        return;
    }

    try {
        const safeId = 'p-' + Math.random().toString(36).substring(2, 8);
        peer = new Peer(safeId, {
            host: '0.peerjs.com',
            port: 443,
            secure: true,
            debug: 0
        });
        
        peer.on('open', (id) => {
            announcePresence(id);
            listenForPeers();
        });

        peer.on('error', (err) => {
            console.error('PeerJS Error:', err);
            showToast('فشل اتصال الصوت: ' + err.type, 'error');
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
        input.disabled = true;
        
        // حفظ الحالة لاستعادتها عند الـ Refresh
        localStorage.setItem('active_room', currentRoom);

    } catch (err) {
        console.error("Room Init Error:", err);
        showToast('فشل تهيئة الغرفة: ' + err.message, 'error');
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
    const icon = document.getElementById('toast-icon');
    document.getElementById('toast-msg').textContent = msg;
    
    if (type === 'error') {
        icon.className = 'fas fa-exclamation-circle text-red-400';
    } else if (type === 'info') {
        icon.className = 'fas fa-info-circle text-blue-400';
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

// ── Boot Sequence ──
document.addEventListener('DOMContentLoaded', () => {
    if (localStorage.getItem('theme') === 'dark' || (!localStorage.getItem('theme') && window.matchMedia('(prefers-color-scheme: dark)').matches)) {
        document.documentElement.classList.add('dark');
    }
    
    initIdentity();
    startFeed();

    // 🔴 استعادة الغرفة إذا كان المستخدم قد عمل Refresh وهو بداخلها
    const savedRoom = localStorage.getItem('active_room');
    if (savedRoom) {
        currentRoom = savedRoom;
        document.getElementById('room-input').value = currentRoom;
        // ننتظر قليلاً لضمان تحميل المكتبات ثم ندخل الغرفة تلقائياً
        setTimeout(() => {
            toggleRoom();
        }, 1000);
    }
});

if ('serviceWorker' in navigator) {
    window.addEventListener('load', () => {
        navigator.serviceWorker.register('./sw.js')
            .then(registration => console.log('SW Registered'))
            .catch(error => console.log('SW Failed:', error));
    });
}
