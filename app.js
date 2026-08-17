/* =========================================================
   Pulse - التطبيق الرئيسي (نسخة محسّنة)
   نظام Nostr + المنشورات + غرف الصوت WebRTC
   ========================================================= */

const RELAYS = [
    'wss://relay.damus.io',
    'wss://relay.primal.net',
    'wss://nos.lol',
    'wss://relay.nostr.band'
];

const APP_TAG = 'pulse-platform';
const ROOM_EVENT_KIND = 20000;
const MAX_SEEN_EVENTS = 2000;
const MAX_RENDERED_POSTS = 80;
const MAX_PROCESSED_LIKES = 1500;

/* =========================================================
   الحالة العامة
   ========================================================= */

let secretKeyHex = null;
let pk = null;
let npub = null;
let usingNip07 = false;

const storageKey = 'pulse_nsec_hex';

const pool = new NostrTools.SimplePool();

const seenEvents = new Set();
const renderedPosts = new Map();
const profileCache = new Map();

let postsSubscription = null;
let reactionsSubscription = null;

let localStream = null;
let peer = null;

let currentRoom = null;
let roomSubscription = null;

let myPeerId = null;

let activeCalls = new Map();
let announcedPeers = new Set();

let isMuted = false;
let isJoiningRoom = false;

let bgAudioContext = null;
let silentAudioElement = null;
let wakeLock = null;

const processedLikes = new Set();

/* =========================================================
   أدوات مساعدة
   ========================================================= */

function $(id) {
    return document.getElementById(id);
}

function escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text ?? '';
    return div.innerHTML;
}

function safeRoomName(name) {
    return String(name || '')
        .trim()
        .toLowerCase()
        .replace(/\s+/g, '-')
        .slice(0, 80);
}

function getErrorMessage(error) {
    if (!error) return 'خطأ غير معروف';
    if (typeof error === 'string') return error;
    return error.message || error.type || 'خطأ غير معروف';
}

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

function limitSet(set, max) {
    if (set.size <= max) return;
    const arr = Array.from(set);
    const removeCount = set.size - max;
    for (let i = 0; i < removeCount; i++) {
        set.delete(arr[i]);
    }
}

function limitMap(map, max) {
    if (map.size <= max) return;
    const keys = Array.from(map.keys());
    const removeCount = map.size - max;
    for (let i = 0; i < removeCount; i++) {
        const el = map.get(keys[i]);
        if (el && el.remove) el.remove();
        map.delete(keys[i]);
    }
}

function getDisplayName(pubkey) {
    const cached = profileCache.get(pubkey);
    if (cached && cached.name) {
        return cached.name.slice(0, 24);
    }
    return pubkey.slice(0, 8) + '...';
}

/* =========================================================
   Toast
   ========================================================= */

function showToast(message, type = 'success') {
    const toast = $('toast');
    const icon = $('toast-icon');
    const msg = $('toast-msg');

    if (!toast || !icon || !msg) {
        console.log('[Toast]', message);
        return;
    }

    msg.textContent = message;

    if (type === 'error') {
        icon.className = 'fas fa-exclamation-circle text-red-400';
    } else if (type === 'info') {
        icon.className = 'fas fa-info-circle text-blue-400';
    } else {
        icon.className = 'fas fa-check-circle text-green-400';
    }

    toast.classList.remove('hidden');
    clearTimeout(toast._timer);
    toast._timer = setTimeout(() => {
        toast.classList.add('hidden');
    }, 3500);
}

/* =========================================================
   الهوية Nostr
   ========================================================= */

async function initIdentity() {
    try {
        if (window.nostr && typeof window.nostr.getPublicKey === 'function') {
            try {
                pk = await window.nostr.getPublicKey();
                npub = NostrTools.nip19.npubEncode(pk);
                usingNip07 = true;
                secretKeyHex = null;
                updateIdentityUI();
                console.log('[Nostr] تم استخدام NIP-07');
                showToast('تم الاتصال بامتداد Nostr (NIP-07)', 'success');
                return;
            } catch (nip07Error) {
                console.warn('[Nostr] NIP-07 فشل، الانتقال للمفتاح المحلي:', nip07Error);
            }
        }

        let hexSk = localStorage.getItem(storageKey);

        const isValidHex =
            typeof hexSk === 'string' &&
            hexSk.length === 64 &&
            /^[0-9a-fA-F]{64}$/.test(hexSk);

        if (!isValidHex) {
            console.log('[Nostr] إنشاء هوية جديدة');
            const generated = NostrTools.generateSecretKey();
            hexSk = Array.from(generated)
                .map(byte => byte.toString(16).padStart(2, '0'))
                .join('');
            localStorage.setItem(storageKey, hexSk);
            showToast('تم إنشاء هوية جديدة. صدّرها واحفظها!', 'info');
        }

        secretKeyHex = hexSk;
        pk = NostrTools.getPublicKey(secretKeyHex);
        npub = NostrTools.nip19.npubEncode(pk);
        usingNip07 = false;

        updateIdentityUI();
        console.log('[Nostr] الهوية جاهزة (محلية)');
    } catch (error) {
        console.error('[Nostr] فشل تهيئة الهوية:', error);
        localStorage.removeItem(storageKey);
        showToast('حدث خطأ في الهوية، سيتم إنشاء هوية جديدة', 'error');
        setTimeout(initIdentity, 800);
    }
}

function updateIdentityUI() {
    const display = $('npub-display');
    if (display) {
        display.textContent = npub
            ? npub.slice(0, 10) + '...' + npub.slice(-6)
            : 'جاري...';
        display.title = npub || '';
    }

    const badge = $('nip07-badge');
    if (badge) {
        if (usingNip07) {
            badge.classList.remove('hidden');
            badge.textContent = 'NIP-07';
        } else {
            badge.classList.add('hidden');
        }
    }
}

async function signEvent(eventTemplate) {
    if (usingNip07 && window.nostr && window.nostr.signEvent) {
        return await window.nostr.signEvent(eventTemplate);
    }
    if (!secretKeyHex) {
        throw new Error('لا يوجد مفتاح توقيع متاح');
    }
    return NostrTools.finalizeEvent(eventTemplate, secretKeyHex);
}

function exportKey() {
    if (usingNip07) {
        showToast('أنت تستخدم امتداد Nostr. صدّر المفتاح من الامتداد نفسه.', 'info');
        return;
    }
    if (!secretKeyHex) {
        showToast('لا يوجد مفتاح للتصدير', 'error');
        return;
    }
    try {
        const nsec = NostrTools.nip19.nsecEncode(
            Uint8Array.from(secretKeyHex.match(/.{1,2}/g).map(b => parseInt(b, 16)))
        );
        if (navigator.clipboard) {
            navigator.clipboard.writeText(nsec).then(() => {
                showToast('تم نسخ المفتاح الخاص (nsec). احفظه في مكان آمن!', 'success');
            }).catch(() => {
                prompt('انسخ مفتاحك الخاص واحفظه:', nsec);
            });
        } else {
            prompt('انسخ مفتاحك الخاص واحفظه:', nsec);
        }
    } catch (error) {
        console.error('[Key] تصدير فشل:', error);
        prompt('انسخ المفتاح (hex):', secretKeyHex);
    }
}

function importKey() {
    if (usingNip07) {
        showToast('عطّل امتداد Nostr أولاً لاستيراد مفتاح محلي', 'info');
        return;
    }

    const input = prompt('الصق nsec أو المفتاح السري (64 حرف hex):');
    if (!input || !input.trim()) return;

    try {
        let hex = input.trim();

        if (hex.startsWith('nsec1')) {
            const decoded = NostrTools.nip19.decode(hex);
            if (decoded.type !== 'nsec') throw new Error('نوع غير صحيح');
            const bytes = decoded.data;
            hex = Array.from(bytes).map(b => b.toString(16).padStart(2, '0')).join('');
        }

        if (!/^[0-9a-fA-F]{64}$/.test(hex)) {
            throw new Error('صيغة المفتاح غير صحيحة');
        }

        localStorage.setItem(storageKey, hex);
        secretKeyHex = hex;
        pk = NostrTools.getPublicKey(secretKeyHex);
        npub = NostrTools.nip19.npubEncode(pk);
        usingNip07 = false;

        updateIdentityUI();
        showToast('تم استيراد المفتاح بنجاح', 'success');

        if (postsSubscription) {
            try { postsSubscription.close(); } catch (e) {}
        }
        seenEvents.clear();
        renderedPosts.clear();
        const container = $('feed-container');
        if (container) container.innerHTML = '';
        startFeed();
    } catch (error) {
        console.error('[Key] استيراد فشل:', error);
        showToast('فشل استيراد المفتاح: ' + getErrorMessage(error), 'error');
    }
}

function copyNpub() {
    if (!npub) return;
    if (navigator.clipboard) {
        navigator.clipboard.writeText(npub).then(() => {
            showToast('تم نسخ npub', 'success');
        }).catch(() => {
            prompt('انسخ npub:', npub);
        });
    } else {
        prompt('انسخ npub:', npub);
    }
}

/* =========================================================
   Profiles (kind 0)
   ========================================================= */

function fetchProfiles(pubkeys) {
    const needed = pubkeys.filter(p => p && !profileCache.has(p));
    if (!needed.length) return;

    try {
        pool.subscribeMany(
            RELAYS,
            [{ kinds: [0], authors: needed.slice(0, 40), limit: 40 }],
            {
                onevent: event => {
                    try {
                        const meta = JSON.parse(event.content || '{}');
                        profileCache.set(event.pubkey, {
                            name: meta.display_name || meta.name || null,
                            picture: meta.picture || null
                        });
                        document.querySelectorAll(`.post-card[data-author="${event.pubkey}"]`).forEach(card => {
                            const nameEl = card.querySelector('.author-name');
                            if (nameEl) nameEl.textContent = getDisplayName(event.pubkey);
                        });
                    } catch (e) {}
                },
                oneose: () => {}
            }
        );
    } catch (error) {
        console.warn('[Profile] فشل جلب الملفات الشخصية:', error);
    }
}

/* =========================================================
   المنشورات
   ========================================================= */

function startFeed() {
    console.log('[Feed] بدء الاشتراك في المنشورات');

    const loading = $('loading-feed');
    if (loading) loading.classList.remove('hidden');

    try {
        postsSubscription = pool.subscribeMany(
            RELAYS,
            [{ kinds: [1], '#t': [APP_TAG], limit: 50 }],
            {
                onevent: event => {
                    if (!event || !event.id) return;

                    if (isReplyEvent(event)) {
                        handleIncomingReply(event);
                        return;
                    }

                    if (seenEvents.has(event.id)) return;

                    seenEvents.add(event.id);
                    limitSet(seenEvents, MAX_SEEN_EVENTS);
                    renderPost(event);
                },
                oneose: () => {
                    console.log('[Feed] تم تحميل المنشورات الأولية');
                    if (loading) loading.classList.add('hidden');
                    startReactionSubscription();
                },
                onclose: () => {
                    console.log('[Feed] اشتراك المنشورات أغلق');
                }
            }
        );
    } catch (error) {
        console.error('[Feed] خطأ في subscribeMany:', error);
        if (loading) loading.classList.add('hidden');
        showToast('تعذر الاتصال بشبكة المنشورات: ' + getErrorMessage(error), 'error');
    }
}

function isReplyEvent(event) {
    if (!event.tags) return false;
    return event.tags.some(tag => tag[0] === 'e' && tag[1]);
}

function getPostCard(postId) {
    return document.querySelector(`.post-card[data-post-id="${CSS.escape(postId)}"]`);
}

function renderPost(event) {
    const container = $('feed-container');
    if (!container) return;
    if (renderedPosts.has(event.id)) return;

    const time = new Date(event.created_at * 1000).toLocaleString('ar-EG', {
        hour: '2-digit',
        minute: '2-digit',
        day: 'numeric',
        month: 'short'
    });

    const displayName = getDisplayName(event.pubkey);

    const div = document.createElement('div');
    div.className =
        'post-card bg-white dark:bg-surface rounded-2xl p-4 shadow-sm border border-gray-100 dark:border-gray-800 fade-in';
    div.dataset.postId = event.id;
    div.dataset.author = event.pubkey;

    div.innerHTML = `
        <div class="flex justify-between items-start mb-3">
            <div class="flex items-center gap-3">
                <div class="avatar w-10 h-10 bg-indigo-500 text-sm">
                    ${escapeHtml(event.pubkey.slice(0, 2).toUpperCase())}
                </div>
                <div>
                    <div class="author-name font-bold text-sm dark:text-white">
                        ${escapeHtml(displayName)}
                    </div>
                    <div class="text-xs text-gray-400">
                        ${escapeHtml(time)}
                    </div>
                </div>
            </div>
        </div>

        <p class="post-content text-gray-800 dark:text-gray-200 leading-relaxed mb-4 whitespace-pre-wrap text-sm md:text-base">
            ${escapeHtml(event.content)}
        </p>

        <div class="flex items-center gap-6 text-gray-400 text-sm border-t border-gray-100 dark:border-gray-800 pt-3">
            <button
                class="like-button flex items-center gap-2 hover:text-red-500 transition"
                onclick="likePost('${event.id}', '${event.pubkey}')"
                data-liked="false"
            >
                <i class="far fa-heart"></i>
                <span>إعجاب</span>
                <span class="like-count" data-count="0">0</span>
            </button>

            <button
                class="reply-button flex items-center gap-2 hover:text-blue-500 transition"
                onclick="replyToPost('${event.id}', '${event.pubkey}')"
            >
                <i class="far fa-comment"></i>
                <span>رد</span>
                <span class="reply-count" data-count="0">0</span>
            </button>
        </div>

        <div class="replies-container mt-3 space-y-2" data-replies="${event.id}"></div>
    `;

    renderedPosts.set(event.id, div);
    limitMap(renderedPosts, MAX_RENDERED_POSTS);
    container.prepend(div);
    fetchProfiles([event.pubkey]);
}

/* =========================================================
   نشر منشور
   ========================================================= */

async function publishPost() {
    const input = $('post-input');
    if (!input) {
        showToast('حقل الكتابة غير موجود', 'error');
        return;
    }

    const content = (input.value || '').trim();
    if (!content) {
        showToast('اكتب شيئًا قبل النشر', 'error');
        return;
    }
    if (content.length > 4000) {
        showToast('النص طويل جدًا', 'error');
        return;
    }

    try {
        const eventTemplate = {
            kind: 1,
            created_at: Math.floor(Date.now() / 1000),
            tags: [['t', APP_TAG]],
            content: content
        };

        const signedEvent = await signEvent(eventTemplate);

        if (!seenEvents.has(signedEvent.id)) {
            seenEvents.add(signedEvent.id);
            renderPost(signedEvent);
        }

        await pool.publish(RELAYS, signedEvent);
        input.value = '';
        showToast('تم النشر بنجاح', 'success');
    } catch (error) {
        console.error('[Post] فشل النشر:', error);
        showToast('فشل النشر: ' + getErrorMessage(error), 'error');
    }
}

/* =========================================================
   الإعجابات والردود
   ========================================================= */

function getReactionStats(postId) {
    const card = getPostCard(postId);
    if (!card) return null;
    return {
        card,
        likeButton: card.querySelector('.like-button'),
        likeCount: card.querySelector('.like-count'),
        replyCount: card.querySelector('.reply-count')
    };
}

function updateLikeUI(postId, liked, countDelta = 0) {
    const stats = getReactionStats(postId);
    if (!stats) return;

    const currentCount = Number(stats.likeCount.dataset.count || 0);
    const newCount = Math.max(0, currentCount + countDelta);

    stats.likeCount.dataset.count = String(newCount);
    stats.likeCount.textContent = String(newCount);
    stats.likeButton.dataset.liked = liked ? 'true' : 'false';

    const icon = stats.likeButton.querySelector('i');
    if (liked) {
        stats.likeButton.classList.add('text-red-500', 'font-bold');
        if (icon) icon.className = 'fas fa-heart text-red-500';
    } else {
        stats.likeButton.classList.remove('text-red-500', 'font-bold');
        if (icon) icon.className = 'far fa-heart';
    }
}

async function likePost(targetId, targetPubkey) {
    const stats = getReactionStats(targetId);
    if (!stats) {
        showToast('تعذر العثور على المنشور', 'error');
        return;
    }
    if (stats.likeButton.dataset.liked === 'true') {
        showToast('لقد أعجبت بهذا المنشور بالفعل', 'info');
        return;
    }

    updateLikeUI(targetId, true, 1);
    stats.likeButton.classList.add('scale-110');
    setTimeout(() => stats.likeButton.classList.remove('scale-110'), 180);

    try {
        const eventTemplate = {
            kind: 7,
            created_at: Math.floor(Date.now() / 1000),
            tags: [
                ['e', targetId],
                ['p', targetPubkey]
            ],
            content: '+'
        };

        const signedEvent = await signEvent(eventTemplate);
        await pool.publish(RELAYS, signedEvent);
        showToast('تم الإعجاب ❤️', 'success');
    } catch (error) {
        console.error('[Like] فشل:', error);
        updateLikeUI(targetId, false, -1);
        showToast('فشل إرسال الإعجاب: ' + getErrorMessage(error), 'error');
    }
}

function startReactionSubscription() {
    const postIds = Array.from(renderedPosts.keys());
    if (!postIds.length) return;

    if (reactionsSubscription) {
        try { reactionsSubscription.close(); } catch (e) {}
    }

    try {
        reactionsSubscription = pool.subscribeMany(
            RELAYS,
            [{ kinds: [7, 1], '#e': postIds, limit: 500 }],
            {
                onevent: event => {
                    if (!event || !event.id) return;
                    if (event.kind === 7) handleIncomingLike(event);
                    if (event.kind === 1) handleIncomingReply(event);
                },
                oneose: () => console.log('[Reactions] تم التحميل')
            }
        );
    } catch (error) {
        console.error('[Reactions] خطأ:', error);
    }
}

function handleIncomingLike(event) {
    if (processedLikes.has(event.id)) return;
    processedLikes.add(event.id);
    limitSet(processedLikes, MAX_PROCESSED_LIKES);

    const targetId = getTagValue(event.tags, 'e');
    if (!targetId) return;

    const stats = getReactionStats(targetId);
    if (!stats) return;
    if (event.pubkey === pk) return;

    const currentCount = Number(stats.likeCount.dataset.count || 0);
    stats.likeCount.dataset.count = String(currentCount + 1);
    stats.likeCount.textContent = String(currentCount + 1);
}

function getTagValue(tags, name) {
    if (!Array.isArray(tags)) return null;
    const tag = tags.find(item => item[0] === name);
    return tag ? tag[1] : null;
}

function handleIncomingReply(event) {
    const targetId = getTagValue(event.tags, 'e');
    if (!targetId) return;

    const stats = getReactionStats(targetId);
    if (!stats) return;

    if (document.querySelector(`[data-reply-id="${CSS.escape(event.id)}"]`)) return;

    const replyCount = Number(stats.replyCount.dataset.count || 0);
    stats.replyCount.dataset.count = String(replyCount + 1);
    stats.replyCount.textContent = String(replyCount + 1);

    const repliesContainer = stats.card.querySelector(`[data-replies="${CSS.escape(targetId)}"]`);
    if (!repliesContainer) return;

    const reply = document.createElement('div');
    reply.dataset.replyId = event.id;
    reply.className = 'bg-gray-50 dark:bg-gray-800 rounded-xl p-3 text-sm';
    reply.innerHTML = `
        <div class="text-xs text-gray-400 mb-1">${escapeHtml(getDisplayName(event.pubkey))}</div>
        <div class="text-gray-700 dark:text-gray-200">${escapeHtml(event.content)}</div>
    `;
    repliesContainer.appendChild(reply);
    fetchProfiles([event.pubkey]);
}

let pendingReply = null;

async function replyToPost(targetId, targetPubkey) {
    const modal = $('reply-modal');
    const textarea = $('reply-input');

    if (modal && textarea) {
        pendingReply = { targetId, targetPubkey };
        textarea.value = '';
        modal.classList.remove('hidden');
        setTimeout(() => textarea.focus(), 50);
        return;
    }

    const content = prompt('اكتب ردك:');
    if (!content || !content.trim()) return;
    await sendReply(targetId, targetPubkey, content.trim());
}

function closeReplyModal() {
    const modal = $('reply-modal');
    if (modal) modal.classList.add('hidden');
    pendingReply = null;
}

async function confirmReply() {
    if (!pendingReply) return;
    const textarea = $('reply-input');
    const content = (textarea?.value || '').trim();
    if (!content) {
        showToast('اكتب ردًا', 'error');
        return;
    }
    const { targetId, targetPubkey } = pendingReply;
    closeReplyModal();
    await sendReply(targetId, targetPubkey, content);
}

async function sendReply(targetId, targetPubkey, cleanContent) {
    try {
        const eventTemplate = {
            kind: 1,
            created_at: Math.floor(Date.now() / 1000),
            tags: [
                ['e', targetId, '', 'reply'],
                ['p', targetPubkey],
                ['t', APP_TAG]
            ],
            content: cleanContent
        };

        const signedEvent = await signEvent(eventTemplate);
        handleIncomingReply(signedEvent);
        await pool.publish(RELAYS, signedEvent);
        showToast('تم إرسال الرد', 'success');
    } catch (error) {
        console.error('[Reply] فشل:', error);
        showToast('فشل إرسال الرد: ' + getErrorMessage(error), 'error');
    }
}

/* =========================================================
   غرف الصوت WebRTC
   ========================================================= */

const WEBRTC_CONFIG = {
    iceServers: [
        {
            urls: [
                'stun:stun.l.google.com:19302',
                'stun:stun1.l.google.com:19302',
                'stun:stun2.l.google.com:19302',
                'stun:stun3.l.google.com:19302',
                'stun:stun4.l.google.com:19302'
            ]
        },
        {
            urls: 'turn:openrelay.metered.ca:80',
            username: 'openrelay',
            credential: 'openrelay'
        },
        {
            urls: 'turn:openrelay.metered.ca:443',
            username: 'openrelay',
            credential: 'openrelay'
        },
        {
            urls: 'turn:openrelay.metered.ca:443?transport=tcp',
            username: 'openrelay',
            credential: 'openrelay'
        }
    ],
    iceTransportPolicy: 'all',
    bundlePolicy: 'max-bundle',
    rtcpMuxPolicy: 'require'
};

function createPeer() {
    return new Promise((resolve, reject) => {
        if (peer && !peer.destroyed) {
            resolve(peer);
            return;
        }

        const peerId =
            'pulse-' +
            (pk || 'anon').slice(0, 8) +
            '-' +
            Math.random().toString(36).slice(2, 8);

        let settled = false;

        try {
            peer = new Peer(peerId, {
                host: '0.peerjs.com',
                port: 443,
                secure: true,
                path: '/',
                debug: 1,
                config: WEBRTC_CONFIG
            });

            peer.on('open', id => {
                myPeerId = id;
                if (!settled) {
                    settled = true;
                    resolve(peer);
                }
            });

            peer.on('call', call => handleIncomingCall(call));

            peer.on('error', error => {
                if (!settled) {
                    settled = true;
                    reject(error);
                }
                handlePeerError(error);
            });

            peer.on('disconnected', () => {
                showToast('انقطع اتصال خدمة الإشارة الصوتية', 'error');
            });
        } catch (error) {
            reject(error);
        }
    });
}

function handlePeerError(error) {
    const type = error?.type || '';
    const message = getErrorMessage(error);

    if (type === 'network' || type === 'server-error' || type === 'socket-error') {
        showToast('مشكلة في شبكة الاتصال الصوتي: ' + message, 'error');
        return;
    }
    if (type === 'unavailable-id') {
        showToast('معرف الاتصال الصوتي مستخدم، حاول مرة أخرى', 'error');
        return;
    }
    if (type === 'browser-incompatible') {
        showToast('المتصفح لا يدعم WebRTC بشكل صحيح', 'error');
        return;
    }
    showToast('خطأ WebRTC: ' + message, 'error');
}

async function toggleRoom(forceLeave = false) {
    if (forceLeave) {
        await leaveRoom();
        return;
    }
    if (isJoiningRoom) return;

    if (currentRoom) {
        await leaveRoom();
        return;
    }

    const input = $('room-input');
    if (!input) return;

    const roomName = safeRoomName(input.value);
    if (!roomName) {
        showToast('اكتب اسم الغرفة أولاً', 'error');
        return;
    }

    await joinRoom(roomName);
}

async function joinRoom(roomName) {
    if (isJoiningRoom) return;
    isJoiningRoom = true;

    try {
        if (!navigator.mediaDevices?.getUserMedia) {
            throw new Error('المتصفح لا يدعم getUserMedia أو الصفحة ليست HTTPS');
        }

        showToast('جاري تشغيل الميكروفون...', 'info');

        try {
            localStream = await navigator.mediaDevices.getUserMedia({
                audio: {
                    echoCancellation: true,
                    noiseSuppression: true,
                    autoGainControl: true,
                    channelCount: 1
                }
            });
        } catch (micError) {
            if (micError.name === 'NotAllowedError') {
                throw new Error('تم رفض صلاحية الميكروفون. اسمح للمتصفح باستخدام الميكروفون.');
            }
            if (micError.name === 'NotFoundError') {
                throw new Error('لم يتم العثور على ميكروفون في الجهاز.');
            }
            if (micError.name === 'NotReadableError') {
                throw new Error('الميكروفون مستخدم بواسطة تطبيق أو متصفح آخر.');
            }
            throw micError;
        }

        await createPeer();
        if (!peer || peer.destroyed) {
            throw new Error('تعذر إنشاء PeerJS');
        }

        currentRoom = roomName;
        localStorage.setItem('active_room', currentRoom);
        announcedPeers.clear();

        updateRoomUI(true);
        startBackgroundAudioEngine();
        requestSystemLock();
        setupVAD();
        await announcePresence();
        listenForPeers();

        if (window._presenceInterval) clearInterval(window._presenceInterval);
        window._presenceInterval = setInterval(() => {
            if (currentRoom) announcePresence();
        }, 45000);

        showToast('دخلت غرفة "' + roomName + '" 🎙️', 'success');
    } catch (error) {
        console.error('[Room] فشل:', error);
        showToast('فشل دخول الغرفة: ' + getErrorMessage(error), 'error');
        cleanupRoomResources(false);
    } finally {
        isJoiningRoom = false;
    }
}

function updateRoomUI(joined) {
    const btn = $('btn-join-room');
    const input = $('room-input');
    const activeUi = $('active-room-ui');

    if (joined) {
        if (activeUi) activeUi.classList.remove('hidden');
        if (btn) {
            btn.textContent = 'مغادرة';
            btn.classList.remove('bg-white', 'text-accent');
            btn.classList.add('bg-red-500', 'text-white');
        }
        if (input) input.disabled = true;
        if ($('current-room-name')) {
            $('current-room-name').textContent = `غرفة: ${currentRoom}`;
        }
    } else {
        if (activeUi) activeUi.classList.add('hidden');
        if (btn) {
            btn.textContent = 'دخول';
            btn.classList.remove('bg-red-500', 'text-white');
            btn.classList.add('bg-white', 'text-accent');
        }
        if (input) input.disabled = false;
    }
}

function roomTag() {
    return `${APP_TAG}:voice:${safeRoomName(currentRoom)}`;
}

async function announcePresence() {
    if (!currentRoom || !myPeerId) return;

    const tag = roomTag();
    const eventTemplate = {
        kind: ROOM_EVENT_KIND,
        created_at: Math.floor(Date.now() / 1000),
        tags: [
            ['t', tag],
            ['room', safeRoomName(currentRoom)]
        ],
        content: JSON.stringify({
            peerId: myPeerId,
            room: safeRoomName(currentRoom),
            npub: npub,
            timestamp: Date.now()
        })
    };

    try {
        const event = await signEvent(eventTemplate);
        await pool.publish(RELAYS, event);
    } catch (error) {
        console.error('[Nostr Room] فشل presence:', error);
        showToast('تم تشغيل الغرفة لكن تعذر إعلان وجودك للشبكة', 'error');
    }
}

function listenForPeers() {
    if (!currentRoom) return;

    if (roomSubscription) {
        try { roomSubscription.close(); } catch (e) {}
    }

    const tag = roomTag();

    try {
        roomSubscription = pool.subscribeMany(
            RELAYS,
            [{ kinds: [ROOM_EVENT_KIND], '#t': [tag], limit: 100 }],
            {
                onevent: event => handleRoomPresence(event),
                oneose: () => {},
                onclose: () => {}
            }
        );
    } catch (error) {
        showToast('فشل نظام اكتشاف المشاركين: ' + getErrorMessage(error), 'error');
    }
}

function handleRoomPresence(event) {
    if (!currentRoom || !event?.content) return;
    if (event.pubkey === pk) return;

    let data;
    try {
        data = JSON.parse(event.content);
    } catch (e) {
        return;
    }

    if (!data.peerId) return;
    if (data.room && safeRoomName(data.room) !== safeRoomName(currentRoom)) return;
    if (announcedPeers.has(data.peerId)) return;
    if (activeCalls.size >= 5) return;

    announcedPeers.add(data.peerId);

    if (myPeerId && myPeerId < data.peerId) {
        connectToPeer(data.peerId, data.npub || data.peerId);
    }
}

function connectToPeer(targetPeerId, displayName) {
    if (!peer || peer.destroyed || !localStream || !currentRoom) return;
    if (targetPeerId === myPeerId) return;
    if (activeCalls.has(targetPeerId)) return;

    try {
        const call = peer.call(targetPeerId, localStream, {
            metadata: { room: currentRoom, caller: myPeerId }
        });
        if (!call) return;
        handleCallEvents(call, displayName);
    } catch (error) {
        showToast('تعذر بدء الاتصال الصوتي مع مشارك', 'error');
    }
}

function handleIncomingCall(call) {
    if (!currentRoom || !localStream) {
        try { call.close(); } catch (e) {}
        return;
    }
    if (activeCalls.has(call.peer)) {
        try { call.close(); } catch (e) {}
        return;
    }

    try {
        call.answer(localStream);
        handleCallEvents(call, call.peer);
    } catch (error) {
        try { call.close(); } catch (e) {}
    }
}

function handleCallEvents(call, displayName) {
    if (!call) return;
    const peerId = call.peer;
    activeCalls.set(peerId, call);

    call.on('stream', remoteStream => {
        addPeerAudio(remoteStream, peerId, displayName);
    });
    call.on('close', () => removePeerCall(peerId));
    call.on('error', () => {
        showToast('انقطع اتصال أحد المشاركين', 'error');
        removePeerCall(peerId);
    });
}

function addPeerAudio(stream, peerId, displayName) {
    if (!stream) return;

    let audio = document.getElementById(`audio-${peerId}`);
    if (!audio) {
        audio = document.createElement('audio');
        audio.id = `audio-${peerId}`;
        audio.autoplay = true;
        audio.playsInline = true;
        audio.setAttribute('playsinline', '');
        audio.controls = false;
        audio.volume = 1;

        const container = $('audio-container');
        if (container) container.appendChild(audio);
        else document.body.appendChild(audio);
    }

    audio.srcObject = stream;

    const playPromise = audio.play();
    if (playPromise) {
        playPromise
            .then(() => updatePeerCount())
            .catch(() => {
                showToast('المتصفح منع تشغيل الصوت. اضغط داخل الصفحة ثم أعد المحاولة.', 'error');
                document.addEventListener('click', () => {
                    audio.play().catch(() => {});
                }, { once: true });
            });
    }

    addPeerToUI(peerId, displayName);
    updatePeerCount();
}

function addPeerToUI(peerId, displayName) {
    const list = $('peers-list');
    if (!list) return;

    const id = `participant-${peerId}`;
    if (document.getElementById(id)) return;

    const div = document.createElement('div');
    div.id = id;
    div.className = 'flex items-center gap-2 bg-gray-50 dark:bg-gray-800 p-2 rounded-lg';

    const safeName = String(displayName || peerId).slice(0, 16);
    div.innerHTML = `
        <div class="w-2 h-2 bg-green-500 rounded-full animate-pulse"></div>
        <span>${escapeHtml(safeName)}</span>
    `;
    list.appendChild(div);
}

function removePeerCall(peerId) {
    const audio = document.getElementById(`audio-${peerId}`);
    if (audio) {
        try { audio.pause(); } catch (e) {}
        audio.srcObject = null;
        audio.remove();
    }

    const participant = document.getElementById(`participant-${peerId}`);
    if (participant) participant.remove();

    activeCalls.delete(peerId);
    updatePeerCount();
}

function updatePeerCount() {
    const count = $('peers-list')?.children.length || activeCalls.size;
    const countElement = $('peer-count');
    if (countElement) {
        countElement.textContent = `الأشخاص: ${count}`;
    }
}

function toggleMute() {
    if (!localStream) {
        showToast('لا يوجد ميكروفون نشط', 'error');
        return;
    }

    const tracks = localStream.getAudioTracks();
    if (!tracks.length) {
        showToast('لم يتم العثور على مسار صوتي', 'error');
        return;
    }

    isMuted = !isMuted;
    tracks.forEach(track => { track.enabled = !isMuted; });

    const btn = $('btn-mute');
    if (btn) {
        btn.innerHTML = isMuted
            ? '<i class="fas fa-microphone-slash text-red-500"></i>'
            : '<i class="fas fa-microphone"></i>';
        btn.classList.toggle('bg-red-100', isMuted);
        btn.classList.toggle('text-red-500', isMuted);
    }

    showToast(isMuted ? 'تم كتم الميكروفون' : 'تم تشغيل الميكروفون', 'success');
}

async function leaveRoom() {
    const previousRoom = currentRoom;
    currentRoom = null;
    localStorage.removeItem('active_room');

    if (window._presenceInterval) {
        clearInterval(window._presenceInterval);
        window._presenceInterval = null;
    }

    cleanupRoomResources(true);
    updateRoomUI(false);
    showToast(previousRoom ? 'تمت مغادرة الغرفة' : 'تم الخروج', 'success');
}

function cleanupRoomResources(destroyPeer = true) {
    if (roomSubscription) {
        try { roomSubscription.close(); } catch (e) {}
        roomSubscription = null;
    }

    announcedPeers.clear();

    activeCalls.forEach(call => {
        try { call.close(); } catch (e) {}
    });
    activeCalls.clear();

    document.querySelectorAll('#audio-container audio, body > audio[id^="audio-"]').forEach(audio => {
        try { audio.pause(); } catch (e) {}
        audio.srcObject = null;
        audio.remove();
    });

    if (localStream) {
        localStream.getTracks().forEach(track => track.stop());
        localStream = null;
    }

    if (destroyPeer && peer) {
        try { peer.destroy(); } catch (e) {}
        peer = null;
        myPeerId = null;
    }

    if (bgAudioContext) {
        try { bgAudioContext.close(); } catch (e) {}
        bgAudioContext = null;
    }

    if (silentAudioElement) {
        try { silentAudioElement.pause(); } catch (e) {}
        silentAudioElement.remove();
        silentAudioElement = null;
    }

    if (wakeLock) {
        try { wakeLock.release(); } catch (e) {}
        wakeLock = null;
    }

    isMuted = false;

    const list = $('peers-list');
    if (list) list.innerHTML = '';

    const muteButton = $('btn-mute');
    if (muteButton) {
        muteButton.innerHTML = '<i class="fas fa-microphone"></i>';
        muteButton.classList.remove('bg-red-100', 'text-red-500');
    }
}

function startBackgroundAudioEngine() {
    try {
        if (!bgAudioContext) {
            const AudioContext = window.AudioContext || window.webkitAudioContext;
            if (!AudioContext) return;

            bgAudioContext = new AudioContext();
            if (bgAudioContext.state === 'suspended') {
                bgAudioContext.resume().catch(() => {});
            }

            const oscillator = bgAudioContext.createOscillator();
            const gain = bgAudioContext.createGain();
            gain.gain.value = 0.00001;
            oscillator.connect(gain);
            gain.connect(bgAudioContext.destination);
            oscillator.start();

            silentAudioElement = document.createElement('audio');
            silentAudioElement.id = 'voice-keepalive';
            silentAudioElement.autoplay = true;
            silentAudioElement.playsInline = true;
            silentAudioElement.muted = true;
            document.body.appendChild(silentAudioElement);
            silentAudioElement.play().catch(() => {});
        } else if (bgAudioContext.state === 'suspended') {
            bgAudioContext.resume().catch(() => {});
        }
    } catch (error) {
        console.error('[Audio] KeepAlive Error:', error);
    }
}

async function requestSystemLock() {
    try {
        if ('wakeLock' in navigator) {
            wakeLock = await navigator.wakeLock.request('screen');
        }
    } catch (error) {}
}

function setupVAD() {
    if (!localStream) return;

    try {
        const AudioContext = window.AudioContext || window.webkitAudioContext;
        if (!AudioContext) return;

        const audioContext = new AudioContext();
        const source = audioContext.createMediaStreamSource(localStream);
        const analyser = audioContext.createAnalyser();
        analyser.fftSize = 256;
        source.connect(analyser);

        const data = new Uint8Array(analyser.frequencyBinCount);

        const interval = setInterval(() => {
            if (!currentRoom) {
                clearInterval(interval);
                try { audioContext.close(); } catch (e) {}
                return;
            }
            if (isMuted) return;

            analyser.getByteFrequencyData(data);
            const volume = data.reduce((sum, v) => sum + v, 0) / data.length;

            const status = $('vad-status');
            if (status) {
                status.textContent = volume > 12
                    ? 'الحالة: تتحدث الآن 🎙️'
                    : 'الحالة: متصل (صامت)';
            }
        }, 200);
    } catch (error) {}
}

async function restoreRoomAfterRefresh() {
    const savedRoom = localStorage.getItem('active_room');
    if (!savedRoom) return;

    const input = $('room-input');
    if (input) input.value = savedRoom;

    currentRoom = null;
    await sleep(800);

    try {
        await joinRoom(safeRoomName(savedRoom));
    } catch (error) {
        showToast('كانت لديك غرفة مفتوحة. اضغط "دخول" لإعادة الاتصال.', 'info');
    }
}

/* =========================================================
   التنقل والمظهر (مع حفظ الصفحة)
   ========================================================= */

function switchView(viewName) {
    document.querySelectorAll('.view-section').forEach(section => {
        section.classList.add('hidden');
    });

    const target = $(`view-${viewName}`);
    if (target) target.classList.remove('hidden');

    document.querySelectorAll('.nav-btn').forEach(button => {
        button.classList.remove('text-accent', 'active');
        button.classList.add('text-gray-400');
    });

    const active = $(`nav-${viewName}`);
    if (active) {
        active.classList.add('text-accent', 'active');
        active.classList.remove('text-gray-400');
    }

    localStorage.setItem('pulse_view', viewName);
}

function toggleTheme() {
    document.documentElement.classList.toggle('dark');
    localStorage.setItem(
        'theme',
        document.documentElement.classList.contains('dark') ? 'dark' : 'light'
    );
}

function toggleSettings() {
    const panel = $('settings-panel');
    if (panel) panel.classList.toggle('hidden');
}

/* =========================================================
   Boot
   ========================================================= */

document.addEventListener('DOMContentLoaded', async () => {
    console.log('[Pulse] بدء تشغيل التطبيق');

    if (
        localStorage.getItem('theme') === 'dark' ||
        (!localStorage.getItem('theme') &&
            window.matchMedia('(prefers-color-scheme: dark)').matches)
    ) {
        document.documentElement.classList.add('dark');
    }

    await initIdentity();
    startFeed();

    // استعادة الصفحة الأخيرة
    const savedView = localStorage.getItem('pulse_view') || 'timeline';
    switchView(savedView);

    const savedRoom = localStorage.getItem('active_room');
    if (savedRoom) {
        switchView('rooms');
        setTimeout(() => restoreRoomAfterRefresh(), 1200);
    }
});

if ('serviceWorker' in navigator) {
    window.addEventListener('load', () => {
        navigator.serviceWorker
            .register('./sw.js')
            .then(() => console.log('[SW] Registered'))
            .catch(error => console.warn('[SW] Failed:', error));
    });
}

window.publishPost = publishPost;
window.likePost = likePost;
window.replyToPost = replyToPost;
window.confirmReply = confirmReply;
window.closeReplyModal = closeReplyModal;
window.toggleRoom = toggleRoom;
window.toggleMute = toggleMute;
window.switchView = switchView;
window.toggleTheme = toggleTheme;
window.toggleSettings = toggleSettings;
window.exportKey = exportKey;
window.importKey = importKey;
window.copyNpub = copyNpub;
window.showToast = showToast;
