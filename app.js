/* =========================================================
   Pulse - التطبيق الرئيسي (نسخة محسّنة + بروفايل + أفاتار)
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
const DISCOVERY_TAG = APP_TAG + ':room-directory';
const ROOM_PRESENCE_TTL_MS = 90 * 1000;

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
let myProfile = { name: '', picture: '', about: '' };

let postsSubscription = null;
let reactionsSubscription = null;

const discoveredRooms = new Map();
let directorySubscription = null;
let directoryCleanupInterval = null;

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
    return String(name || '').trim().toLowerCase().replace(/\s+/g, '-').slice(0, 80);
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
    for (let i = 0; i < set.size - max; i++) set.delete(arr[i]);
}

function limitMap(map, max) {
    if (map.size <= max) return;
    const keys = Array.from(map.keys());
    for (let i = 0; i < map.size - max; i++) {
        const el = map.get(keys[i]);
        if (el && el.remove) el.remove();
        map.delete(keys[i]);
    }
}

function getDisplayName(pubkey) {
    const cached = profileCache.get(pubkey);
    if (cached && cached.name) return cached.name.slice(0, 24);
    return (pubkey || '').slice(0, 8) + '...';
}

function getAvatarHtml(pubkey, sizeClass = 'w-10 h-10') {
    const c = profileCache.get(pubkey);
    const letter = (c?.name || pubkey || '?').slice(0, 1).toUpperCase();
    if (c?.picture) {
        return `<img src="${escapeHtml(c.picture)}" alt="" class="avatar ${sizeClass} object-cover" onerror="this.outerHTML='<div class=\\'avatar ${sizeClass} bg-indigo-500 text-sm\\'>${escapeHtml(letter)}</div>'">`;
    }
    return `<div class="avatar ${sizeClass} bg-indigo-500 text-sm">${escapeHtml(letter)}</div>`;
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
    if (type === 'error') icon.className = 'fas fa-exclamation-circle text-red-400';
    else if (type === 'info') icon.className = 'fas fa-info-circle text-blue-400';
    else icon.className = 'fas fa-check-circle text-green-400';
    toast.classList.remove('hidden');
    clearTimeout(toast._timer);
    toast._timer = setTimeout(() => toast.classList.add('hidden'), 3500);
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
                showToast('تم الاتصال بامتداد Nostr (NIP-07)', 'success');
                return;
            } catch (e) {
                console.warn('[Nostr] NIP-07 فشل:', e);
            }
        }

        let hexSk = localStorage.getItem(storageKey);
        const isValidHex = typeof hexSk === 'string' && hexSk.length === 64 && /^[0-9a-fA-F]{64}$/.test(hexSk);

        if (!isValidHex) {
            const generated = NostrTools.generateSecretKey();
            hexSk = Array.from(generated).map(b => b.toString(16).padStart(2, '0')).join('');
            localStorage.setItem(storageKey, hexSk);
            showToast('تم إنشاء هوية جديدة. صدّرها واحفظها!', 'info');
        }

        secretKeyHex = hexSk;
        pk = NostrTools.getPublicKey(secretKeyHex);
        npub = NostrTools.nip19.npubEncode(pk);
        usingNip07 = false;
        updateIdentityUI();
    } catch (error) {
        console.error('[Nostr] فشل الهوية:', error);
        localStorage.removeItem(storageKey);
        showToast('حدث خطأ في الهوية، سيتم إنشاء هوية جديدة', 'error');
        setTimeout(initIdentity, 800);
    }
}

function updateIdentityUI() {
    const display = $('npub-display');
    if (display) {
        display.textContent = npub ? npub.slice(0, 10) + '...' + npub.slice(-6) : 'جاري...';
        display.title = npub || '';
    }
    const badge = $('nip07-badge');
    if (badge) {
        if (usingNip07) {
            badge.classList.remove('hidden');
            badge.textContent = 'NIP-07';
        } else badge.classList.add('hidden');
    }
}

async function signEvent(eventTemplate) {
    if (usingNip07 && window.nostr?.signEvent) {
        return await window.nostr.signEvent(eventTemplate);
    }
    if (!secretKeyHex) throw new Error('لا يوجد مفتاح توقيع متاح');
    return NostrTools.finalizeEvent(eventTemplate, secretKeyHex);
}

function exportKey() {
    if (usingNip07) {
        showToast('أنت تستخدم امتداد Nostr. صدّر المفتاح من الامتداد.', 'info');
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
                showToast('تم نسخ المفتاح الخاص. احفظه في مكان آمن!', 'success');
            }).catch(() => prompt('انسخ مفتاحك:', nsec));
        } else prompt('انسخ مفتاحك:', nsec);
    } catch (e) {
        prompt('انسخ المفتاح (hex):', secretKeyHex);
    }
}

function importKey() {
    if (usingNip07) {
        showToast('عطّل امتداد Nostr أولاً لاستيراد مفتاح محلي', 'info');
        return;
    }
    const input = prompt('الصق nsec أو المفتاح السري (64 حرف hex):');
    if (!input?.trim()) return;
    try {
        let hex = input.trim();
        if (hex.startsWith('nsec1')) {
            const decoded = NostrTools.nip19.decode(hex);
            if (decoded.type !== 'nsec') throw new Error('نوع غير صحيح');
            hex = Array.from(decoded.data).map(b => b.toString(16).padStart(2, '0')).join('');
        }
        if (!/^[0-9a-fA-F]{64}$/.test(hex)) throw new Error('صيغة المفتاح غير صحيحة');
        localStorage.setItem(storageKey, hex);
        secretKeyHex = hex;
        pk = NostrTools.getPublicKey(secretKeyHex);
        npub = NostrTools.nip19.npubEncode(pk);
        usingNip07 = false;
        updateIdentityUI();
        loadMyProfile();
        showToast('تم استيراد المفتاح بنجاح', 'success');
        if (postsSubscription) try { postsSubscription.close(); } catch (e) {}
        seenEvents.clear();
        renderedPosts.clear();
        const container = $('feed-container');
        if (container) container.innerHTML = '';
        startFeed();
    } catch (error) {
        showToast('فشل استيراد المفتاح: ' + getErrorMessage(error), 'error');
    }
}

function copyNpub() {
    if (!npub) return;
    if (navigator.clipboard) {
        navigator.clipboard.writeText(npub).then(() => showToast('تم نسخ npub', 'success'))
            .catch(() => prompt('انسخ npub:', npub));
    } else prompt('انسخ npub:', npub);
}

/* =========================================================
   Profiles (kind 0) — قراءة + تعديل + أفاتار
   ========================================================= */

function fetchProfiles(pubkeys) {
    const needed = [...new Set(pubkeys)].filter(p => p && !profileCache.has(p));
    if (!needed.length) return;
    try {
        pool.subscribeMany(RELAYS, [{ kinds: [0], authors: needed.slice(0, 40), limit: 40 }], {
            onevent: event => {
                try {
                    const meta = JSON.parse(event.content || '{}');
                    profileCache.set(event.pubkey, {
                        name: meta.display_name || meta.name || null,
                        picture: meta.picture || null,
                        about: meta.about || null
                    });
                    updateAvatarsInDom(event.pubkey);
                } catch (e) {}
            }
        });
    } catch (error) {
        console.warn('[Profile]', error);
    }
}

function updateAvatarsInDom(pubkey) {
    const name = getDisplayName(pubkey);
    document.querySelectorAll(`.post-card[data-author="${pubkey}"] .author-name`).forEach(el => {
        el.textContent = name;
    });
    document.querySelectorAll(`.post-card[data-author="${pubkey}"] .author-avatar-wrap`).forEach(el => {
        el.innerHTML = getAvatarHtml(pubkey, 'w-10 h-10');
    });
    if (pubkey === pk) updateHeaderAvatar();
}

function loadMyProfile() {
    if (!pk) return;
    try {
        pool.subscribeMany(RELAYS, [{ kinds: [0], authors: [pk], limit: 1 }], {
            onevent: event => {
                try {
                    const meta = JSON.parse(event.content || '{}');
                    myProfile = {
                        name: meta.display_name || meta.name || '',
                        picture: meta.picture || '',
                        about: meta.about || ''
                    };
                    profileCache.set(pk, {
                        name: myProfile.name || null,
                        picture: myProfile.picture || null,
                        about: myProfile.about || null
                    });
                    updateHeaderAvatar();
                } catch (e) {}
            }
        });
    } catch (e) {}
}

function updateHeaderAvatar() {
    const img = $('header-avatar-img');
    const fb = $('header-avatar-fallback');
    if (!img || !fb) return;
    if (myProfile.picture) {
        img.src = myProfile.picture;
        img.classList.remove('hidden');
        fb.classList.add('hidden');
    } else {
        img.classList.add('hidden');
        fb.classList.remove('hidden');
        fb.textContent = (myProfile.name || 'P').slice(0, 1).toUpperCase();
    }
}

function openProfileModal() {
    const modal = $('profile-modal');
    if (!modal) return;
    if ($('profile-name')) $('profile-name').value = myProfile.name || '';
    if ($('profile-picture')) $('profile-picture').value = myProfile.picture || '';
    if ($('profile-about')) $('profile-about').value = myProfile.about || '';
    previewProfilePicture();
    modal.classList.remove('hidden');
    $('settings-panel')?.classList.add('hidden');
}

function closeProfileModal() {
    $('profile-modal')?.classList.add('hidden');
}

function previewProfilePicture() {
    const url = ($('profile-picture')?.value || '').trim();
    const img = $('profile-preview-img');
    const letter = $('profile-preview-letter');
    if (!img || !letter) return;
    if (url) {
        img.src = url;
        img.classList.remove('hidden');
        letter.classList.add('hidden');
    } else {
        img.classList.add('hidden');
        letter.classList.remove('hidden');
        letter.textContent = (($('profile-name')?.value) || 'P').slice(0, 1).toUpperCase();
    }
}

async function saveProfile() {
    const name = ($('profile-name')?.value || '').trim().slice(0, 50);
    const picture = ($('profile-picture')?.value || '').trim().slice(0, 500);
    const about = ($('profile-about')?.value || '').trim().slice(0, 250);
    if (!name) {
        showToast('اكتب اسمًا على الأقل', 'error');
        return;
    }
    try {
        const content = JSON.stringify({
            name,
            display_name: name,
            ...(picture ? { picture } : {}),
            ...(about ? { about } : {})
        });
        const signed = await signEvent({
            kind: 0,
            created_at: Math.floor(Date.now() / 1000),
            tags: [],
            content
        });
        await pool.publish(RELAYS, signed);
        myProfile = { name, picture, about };
        profileCache.set(pk, { name, picture: picture || null, about: about || null });
        updateHeaderAvatar();
        updateAvatarsInDom(pk);
        closeProfileModal();
        showToast('تم حفظ الملف الشخصي', 'success');
    } catch (error) {
        showToast('فشل حفظ البروفايل: ' + getErrorMessage(error), 'error');
    }
}

/* =========================================================
   المنشورات
   ========================================================= */

function startFeed() {
    const loading = $('loading-feed');
    if (loading) loading.classList.remove('hidden');
    try {
        postsSubscription = pool.subscribeMany(
            RELAYS,
            [{ kinds: [1], '#t': [APP_TAG], limit: 50 }],
            {
                onevent: event => {
                    if (!event?.id) return;
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
                    if (loading) loading.classList.add('hidden');
                    startReactionSubscription();
                },
                onclose: () => {}
            }
        );
    } catch (error) {
        if (loading) loading.classList.add('hidden');
        showToast('تعذر الاتصال بشبكة المنشورات: ' + getErrorMessage(error), 'error');
    }
}

function isReplyEvent(event) {
    return event.tags?.some(tag => tag[0] === 'e' && tag[1]) || false;
}

function getPostCard(postId) {
    return document.querySelector(`.post-card[data-post-id="${CSS.escape(postId)}"]`);
}

function renderPost(event) {
    const container = $('feed-container');
    if (!container || renderedPosts.has(event.id)) return;

    const time = new Date(event.created_at * 1000).toLocaleString('ar-EG', {
        hour: '2-digit', minute: '2-digit', day: 'numeric', month: 'short'
    });
    const displayName = getDisplayName(event.pubkey);

    const div = document.createElement('div');
    div.className = 'post-card bg-white dark:bg-surface rounded-2xl p-4 shadow-sm border border-gray-100 dark:border-gray-800 fade-in';
    div.dataset.postId = event.id;
    div.dataset.author = event.pubkey;

    div.innerHTML = `
        <div class="flex justify-between items-start mb-3">
            <div class="flex items-center gap-3">
                <div class="author-avatar-wrap">${getAvatarHtml(event.pubkey, 'w-10 h-10')}</div>
                <div>
                    <div class="author-name font-bold text-sm dark:text-white">${escapeHtml(displayName)}</div>
                    <div class="text-xs text-gray-400">${escapeHtml(time)}</div>
                </div>
            </div>
        </div>
        <p class="post-content text-gray-800 dark:text-gray-200 leading-relaxed mb-4 whitespace-pre-wrap text-sm md:text-base">${escapeHtml(event.content)}</p>
        <div class="flex items-center gap-6 text-gray-400 text-sm border-t border-gray-100 dark:border-gray-800 pt-3">
            <button class="like-button flex items-center gap-2 hover:text-red-500 transition" onclick="likePost('${event.id}', '${event.pubkey}')" data-liked="false">
                <i class="far fa-heart"></i><span>إعجاب</span><span class="like-count" data-count="0">0</span>
            </button>
            <button class="reply-button flex items-center gap-2 hover:text-blue-500 transition" onclick="replyToPost('${event.id}', '${event.pubkey}')">
                <i class="far fa-comment"></i><span>رد</span><span class="reply-count" data-count="0">0</span>
            </button>
        </div>
        <div class="replies-container mt-3 space-y-2" data-replies="${event.id}"></div>
    `;
    renderedPosts.set(event.id, div);
    limitMap(renderedPosts, MAX_RENDERED_POSTS);
    container.prepend(div);
    fetchProfiles([event.pubkey]);
}

async function publishPost() {
    const input = $('post-input');
    if (!input) return showToast('حقل الكتابة غير موجود', 'error');
    const content = (input.value || '').trim();
    if (!content) return showToast('اكتب شيئًا قبل النشر', 'error');
    if (content.length > 4000) return showToast('النص طويل جدًا', 'error');
    try {
        const signedEvent = await signEvent({
            kind: 1,
            created_at: Math.floor(Date.now() / 1000),
            tags: [['t', APP_TAG]],
            content
        });
        if (!seenEvents.has(signedEvent.id)) {
            seenEvents.add(signedEvent.id);
            renderPost(signedEvent);
        }
        await pool.publish(RELAYS, signedEvent);
        input.value = '';
        showToast('تم النشر بنجاح', 'success');
    } catch (error) {
        showToast('فشل النشر: ' + getErrorMessage(error), 'error');
    }
}

/* =========================================================
   إعجابات وردود
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
    if (!stats) return showToast('تعذر العثور على المنشور', 'error');
    if (stats.likeButton.dataset.liked === 'true') return showToast('لقد أعجبت بهذا المنشور بالفعل', 'info');
    updateLikeUI(targetId, true, 1);
    stats.likeButton.classList.add('scale-110');
    setTimeout(() => stats.likeButton.classList.remove('scale-110'), 180);
    try {
        const signedEvent = await signEvent({
            kind: 7,
            created_at: Math.floor(Date.now() / 1000),
            tags: [['e', targetId], ['p', targetPubkey]],
            content: '+'
        });
        await pool.publish(RELAYS, signedEvent);
        showToast('تم الإعجاب ❤️', 'success');
    } catch (error) {
        updateLikeUI(targetId, false, -1);
        showToast('فشل إرسال الإعجاب: ' + getErrorMessage(error), 'error');
    }
}

function startReactionSubscription() {
    const postIds = Array.from(renderedPosts.keys());
    if (!postIds.length) return;
    if (reactionsSubscription) try { reactionsSubscription.close(); } catch (e) {}
    try {
        reactionsSubscription = pool.subscribeMany(
            RELAYS,
            [{ kinds: [7, 1], '#e': postIds, limit: 500 }],
            {
                onevent: event => {
                    if (!event?.id) return;
                    if (event.kind === 7) handleIncomingLike(event);
                    if (event.kind === 1) handleIncomingReply(event);
                }
            }
        );
    } catch (e) {}
}

function handleIncomingLike(event) {
    if (processedLikes.has(event.id)) return;
    processedLikes.add(event.id);
    limitSet(processedLikes, MAX_PROCESSED_LIKES);
    const targetId = getTagValue(event.tags, 'e');
    if (!targetId) return;
    const stats = getReactionStats(targetId);
    if (!stats || event.pubkey === pk) return;
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
        <div class="flex items-start gap-2">
            <div class="shrink-0">${getAvatarHtml(event.pubkey, 'w-7 h-7')}</div>
            <div>
                <div class="text-xs text-gray-400 mb-0.5">${escapeHtml(getDisplayName(event.pubkey))}</div>
                <div class="text-gray-700 dark:text-gray-200">${escapeHtml(event.content)}</div>
            </div>
        </div>`;
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
    if (!content?.trim()) return;
    await sendReply(targetId, targetPubkey, content.trim());
}

function closeReplyModal() {
    $('reply-modal')?.classList.add('hidden');
    pendingReply = null;
}

async function confirmReply() {
    if (!pendingReply) return;
    const content = ($('reply-input')?.value || '').trim();
    if (!content) return showToast('اكتب ردًا', 'error');
    const { targetId, targetPubkey } = pendingReply;
    closeReplyModal();
    await sendReply(targetId, targetPubkey, content);
}

async function sendReply(targetId, targetPubkey, cleanContent) {
    try {
        const signedEvent = await signEvent({
            kind: 1,
            created_at: Math.floor(Date.now() / 1000),
            tags: [['e', targetId, '', 'reply'], ['p', targetPubkey], ['t', APP_TAG]],
            content: cleanContent
        });
        handleIncomingReply(signedEvent);
        await pool.publish(RELAYS, signedEvent);
        showToast('تم إرسال الرد', 'success');
    } catch (error) {
        showToast('فشل إرسال الرد: ' + getErrorMessage(error), 'error');
    }
}

/* =========================================================
   غرف الصوت WebRTC
   ========================================================= */

const WEBRTC_CONFIG = {
    iceServers: [
        { urls: ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302', 'stun:stun2.l.google.com:19302', 'stun:stun3.l.google.com:19302', 'stun:stun4.l.google.com:19302'] },
        { urls: 'turn:openrelay.metered.ca:80', username: 'openrelay', credential: 'openrelay' },
        { urls: 'turn:openrelay.metered.ca:443', username: 'openrelay', credential: 'openrelay' },
        { urls: 'turn:openrelay.metered.ca:443?transport=tcp', username: 'openrelay', credential: 'openrelay' }
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
        const peerId = 'pulse-' + (pk || 'anon').slice(0, 8) + '-' + Math.random().toString(36).slice(2, 8);
        let settled = false;
        try {
            peer = new Peer(peerId, {
                host: '0.peerjs.com', port: 443, secure: true, path: '/', debug: 1, config: WEBRTC_CONFIG
            });
            peer.on('open', id => {
                myPeerId = id;
                if (!settled) { settled = true; resolve(peer); }
            });
            peer.on('call', call => handleIncomingCall(call));
            peer.on('error', error => {
                if (!settled) { settled = true; reject(error); }
                handlePeerError(error);
            });
            peer.on('disconnected', () => showToast('انقطع اتصال خدمة الإشارة الصوتية', 'error'));
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
    } else if (type === 'unavailable-id') {
        showToast('معرف الاتصال مستخدم، حاول مرة أخرى', 'error');
    } else if (type === 'browser-incompatible') {
        showToast('المتصفح لا يدعم WebRTC', 'error');
    } else {
        showToast('خطأ WebRTC: ' + message, 'error');
    }
}

async function toggleRoom(forceLeave = false) {
    if (forceLeave) return leaveRoom();
    if (isJoiningRoom) return;
    if (currentRoom) return leaveRoom();
    const input = $('room-input');
    if (!input) return;
    const roomName = safeRoomName(input.value);
    if (!roomName) return showToast('اكتب اسم الغرفة أولاً', 'error');
    await joinRoom(roomName);
}

async function joinRoom(roomName) {
    if (isJoiningRoom) return;
    isJoiningRoom = true;
    try {
        if (!navigator.mediaDevices?.getUserMedia) {
            throw new Error('المتصفح لا يدعم الميكروفون أو الصفحة ليست HTTPS');
        }
        showToast('جاري تشغيل الميكروفون...', 'info');
        try {
            localStream = await navigator.mediaDevices.getUserMedia({
                audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1 }
            });
        } catch (micError) {
            if (micError.name === 'NotAllowedError') throw new Error('تم رفض صلاحية الميكروفون');
            if (micError.name === 'NotFoundError') throw new Error('لم يتم العثور على ميكروفون');
            if (micError.name === 'NotReadableError') throw new Error('الميكروفون مستخدم من تطبيق آخر');
            throw micError;
        }
        await createPeer();
        if (!peer || peer.destroyed) throw new Error('تعذر إنشاء PeerJS');
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
        window._presenceInterval = setInterval(() => { if (currentRoom) announcePresence(); }, 45000);
        showToast('دخلت غرفة "' + roomName + '" 🎙️', 'success');
    } catch (error) {
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
    const directoryUi = $('live-rooms-section');
    if (joined) {
        activeUi?.classList.remove('hidden');
        directoryUi?.classList.add('hidden');
        if (btn) {
            btn.textContent = 'مغادرة';
            btn.classList.remove('bg-white', 'text-accent');
            btn.classList.add('bg-red-500', 'text-white');
        }
        if (input) input.disabled = true;
        if ($('current-room-name')) $('current-room-name').textContent = `غرفة: ${currentRoom}`;
    } else {
        activeUi?.classList.add('hidden');
        directoryUi?.classList.remove('hidden');
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
    try {
        const event = await signEvent({
            kind: ROOM_EVENT_KIND,
            created_at: Math.floor(Date.now() / 1000),
            tags: [['t', roomTag()], ['t', DISCOVERY_TAG], ['room', safeRoomName(currentRoom)]],
            content: JSON.stringify({ peerId: myPeerId, room: safeRoomName(currentRoom), npub, timestamp: Date.now() })
        });
        await pool.publish(RELAYS, event);
    } catch (error) {
        showToast('تعذر إعلان وجودك للشبكة', 'error');
    }
}

function listenForPeers() {
    if (!currentRoom) return;
    if (roomSubscription) try { roomSubscription.close(); } catch (e) {}
    try {
        roomSubscription = pool.subscribeMany(
            RELAYS,
            [{ kinds: [ROOM_EVENT_KIND], '#t': [roomTag()], limit: 100 }],
            { onevent: event => handleRoomPresence(event) }
        );
    } catch (error) {
        showToast('فشل اكتشاف المشاركين: ' + getErrorMessage(error), 'error');
    }
}

function handleRoomPresence(event) {
    if (!currentRoom || !event?.content || event.pubkey === pk) return;
    let data;
    try { data = JSON.parse(event.content); } catch (e) { return; }
    if (!data.peerId) return;
    if (data.room && safeRoomName(data.room) !== safeRoomName(currentRoom)) return;
    if (announcedPeers.has(data.peerId) || activeCalls.size >= 5) return;
    announcedPeers.add(data.peerId);
    if (myPeerId && myPeerId < data.peerId) {
        connectToPeer(data.peerId, data.npub || data.peerId);
    }
}

function connectToPeer(targetPeerId, displayName) {
    if (!peer || peer.destroyed || !localStream || !currentRoom) return;
    if (targetPeerId === myPeerId || activeCalls.has(targetPeerId)) return;
    try {
        const call = peer.call(targetPeerId, localStream, { metadata: { room: currentRoom, caller: myPeerId } });
        if (call) handleCallEvents(call, displayName);
    } catch (e) {
        showToast('تعذر بدء الاتصال الصوتي', 'error');
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
    } catch (e) {
        try { call.close(); } catch (e2) {}
    }
}

function handleCallEvents(call, displayName) {
    if (!call) return;
    const peerId = call.peer;
    activeCalls.set(peerId, call);
    call.on('stream', remoteStream => addPeerAudio(remoteStream, peerId, displayName));
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
        ($('audio-container') || document.body).appendChild(audio);
    }
    audio.srcObject = stream;
    audio.play().then(() => updatePeerCount()).catch(() => {
        showToast('المتصفح منع الصوت. اضغط داخل الصفحة.', 'error');
        document.addEventListener('click', () => audio.play().catch(() => {}), { once: true });
    });
    addPeerToUI(peerId, displayName);
    updatePeerCount();
}

function addPeerToUI(peerId, displayName) {
    const list = $('peers-list');
    if (!list || document.getElementById(`participant-${peerId}`)) return;
    const div = document.createElement('div');
    div.id = `participant-${peerId}`;
    div.className = 'flex items-center gap-2 bg-gray-50 dark:bg-gray-800 p-2 rounded-lg';
    const safeName = String(displayName || peerId).slice(0, 16);
    div.innerHTML = `
        <div class="w-2 h-2 bg-green-500 rounded-full animate-pulse"></div>
        <span>${escapeHtml(safeName)}</span>`;
    list.appendChild(div);
}

function removePeerCall(peerId) {
    const audio = document.getElementById(`audio-${peerId}`);
    if (audio) {
        try { audio.pause(); } catch (e) {}
        audio.srcObject = null;
        audio.remove();
    }
    document.getElementById(`participant-${peerId}`)?.remove();
    activeCalls.delete(peerId);
    updatePeerCount();
}

function updatePeerCount() {
    const count = $('peers-list')?.children.length || activeCalls.size;
    const el = $('peer-count');
    if (el) el.textContent = `الأشخاص: ${count}`;
}

function toggleMute() {
    if (!localStream) return showToast('لا يوجد ميكروفون نشط', 'error');
    const tracks = localStream.getAudioTracks();
    if (!tracks.length) return showToast('لم يتم العثور على مسار صوتي', 'error');
    isMuted = !isMuted;
    tracks.forEach(t => { t.enabled = !isMuted; });
    const btn = $('btn-mute');
    if (btn) {
        btn.innerHTML = isMuted ? '<i class="fas fa-microphone-slash text-red-500"></i>' : '<i class="fas fa-microphone"></i>';
        btn.classList.toggle('bg-red-100', isMuted);
        btn.classList.toggle('text-red-500', isMuted);
    }
    showToast(isMuted ? 'تم كتم الميكروفون' : 'تم تشغيل الميكروفون', 'success');
}

/* =========================================================
   اكتشاف الغرف الحية
   ========================================================= */

function startRoomDirectory() {
    if (directorySubscription) return;
    try {
        directorySubscription = pool.subscribeMany(
            RELAYS,
            [{ kinds: [ROOM_EVENT_KIND], '#t': [DISCOVERY_TAG], limit: 300 }],
            {
                onevent: event => handleDirectoryPresence(event),
                oneose: () => renderRoomDirectory()
            }
        );
    } catch (e) {
        console.warn('[Room Directory]', e);
    }
    if (!directoryCleanupInterval) {
        directoryCleanupInterval = setInterval(() => {
            pruneRoomDirectory();
            renderRoomDirectory();
        }, 15000);
    }
}

function handleDirectoryPresence(event) {
    if (!event?.content) return;
    let data;
    try { data = JSON.parse(event.content); } catch (e) { return; }
    const roomTagValue = event.tags.find(t => t[0] === 'room')?.[1];
    const roomName = safeRoomName(roomTagValue || data.room || '');
    if (!roomName || !data.peerId) return;
    if (!discoveredRooms.has(roomName)) discoveredRooms.set(roomName, new Map());
    discoveredRooms.get(roomName).set(event.pubkey, { peerId: data.peerId, lastSeen: Date.now() });
    renderRoomDirectory();
}

function pruneRoomDirectory() {
    const now = Date.now();
    discoveredRooms.forEach((members, roomName) => {
        members.forEach((info, pubkey) => {
            if (now - info.lastSeen > ROOM_PRESENCE_TTL_MS) members.delete(pubkey);
        });
        if (members.size === 0) discoveredRooms.delete(roomName);
    });
}

function renderRoomDirectory() {
    const container = $('live-rooms-list');
    const emptyState = $('live-rooms-empty');
    if (!container) return;
    pruneRoomDirectory();
    const rooms = Array.from(discoveredRooms.entries())
        .map(([name, members]) => ({ name, count: members.size }))
        .filter(r => r.count > 0)
        .sort((a, b) => b.count - a.count)
        .slice(0, 12);
    if (!rooms.length) {
        container.innerHTML = '';
        emptyState?.classList.remove('hidden');
        return;
    }
    emptyState?.classList.add('hidden');
    container.innerHTML = rooms.map(room => `
        <button onclick="joinDiscoveredRoom('${room.name.replace(/'/g, "\\'")}')"
            class="w-full flex items-center justify-between gap-3 bg-gray-50 dark:bg-gray-800 hover:bg-gray-100 dark:hover:bg-gray-700 transition rounded-xl px-4 py-3 text-right">
            <span class="flex items-center gap-2 text-sm font-bold text-gray-800 dark:text-gray-100">
                <i class="fas fa-circle text-[8px] text-green-500 animate-pulse"></i>
                ${escapeHtml(room.name)}
            </span>
            <span class="text-xs text-gray-400 shrink-0"><i class="fas fa-user-friends ml-1"></i>${room.count}</span>
        </button>`).join('');
}

function joinDiscoveredRoom(roomName) {
    if (currentRoom) return;
    const input = $('room-input');
    if (input) input.value = roomName;
    joinRoom(safeRoomName(roomName));
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
    if (roomSubscription) try { roomSubscription.close(); } catch (e) {}
    roomSubscription = null;
    announcedPeers.clear();
    activeCalls.forEach(c => { try { c.close(); } catch (e) {} });
    activeCalls.clear();
    document.querySelectorAll('#audio-container audio, body > audio[id^="audio-"]').forEach(audio => {
        try { audio.pause(); } catch (e) {}
        audio.srcObject = null;
        audio.remove();
    });
    if (localStream) {
        localStream.getTracks().forEach(t => t.stop());
        localStream = null;
    }
    if (destroyPeer && peer) {
        try { peer.destroy(); } catch (e) {}
        peer = null;
        myPeerId = null;
    }
    if (bgAudioContext) try { bgAudioContext.close(); } catch (e) {}
    bgAudioContext = null;
    if (silentAudioElement) {
        try { silentAudioElement.pause(); } catch (e) {}
        silentAudioElement.remove();
        silentAudioElement = null;
    }
    if (wakeLock) try { wakeLock.release(); } catch (e) {}
    wakeLock = null;
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
            const AC = window.AudioContext || window.webkitAudioContext;
            if (!AC) return;
            bgAudioContext = new AC();
            if (bgAudioContext.state === 'suspended') bgAudioContext.resume().catch(() => {});
            const osc = bgAudioContext.createOscillator();
            const gain = bgAudioContext.createGain();
            gain.gain.value = 0.00001;
            osc.connect(gain);
            gain.connect(bgAudioContext.destination);
            osc.start();
            silentAudioElement = document.createElement('audio');
            silentAudioElement.autoplay = true;
            silentAudioElement.playsInline = true;
            silentAudioElement.muted = true;
            document.body.appendChild(silentAudioElement);
            silentAudioElement.play().catch(() => {});
        } else if (bgAudioContext.state === 'suspended') {
            bgAudioContext.resume().catch(() => {});
        }
    } catch (e) {}
}

async function requestSystemLock() {
    try {
        if ('wakeLock' in navigator) wakeLock = await navigator.wakeLock.request('screen');
    } catch (e) {}
}

function setupVAD() {
    if (!localStream) return;
    try {
        const AC = window.AudioContext || window.webkitAudioContext;
        if (!AC) return;
        const audioContext = new AC();
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
            const volume = data.reduce((s, v) => s + v, 0) / data.length;
            const status = $('vad-status');
            if (status) status.textContent = volume > 12 ? 'الحالة: تتحدث الآن 🎙️' : 'الحالة: متصل (صامت)';
        }, 200);
    } catch (e) {}
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
    } catch (e) {
        showToast('كانت لديك غرفة مفتوحة. اضغط دخول لإعادة الاتصال.', 'info');
    }
}

/* =========================================================
   تنقل ومظهر
   ========================================================= */

function switchView(viewName) {
    document.querySelectorAll('.view-section').forEach(s => s.classList.add('hidden'));
    $(`view-${viewName}`)?.classList.remove('hidden');
    document.querySelectorAll('.nav-btn').forEach(b => {
        b.classList.remove('text-accent', 'active');
        b.classList.add('text-gray-400');
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
    localStorage.setItem('theme', document.documentElement.classList.contains('dark') ? 'dark' : 'light');
}

function toggleSettings() {
    $('settings-panel')?.classList.toggle('hidden');
}

/* =========================================================
   Boot
   ========================================================= */

document.addEventListener('DOMContentLoaded', async () => {
    if (
        localStorage.getItem('theme') === 'dark' ||
        (!localStorage.getItem('theme') && window.matchMedia('(prefers-color-scheme: dark)').matches)
    ) {
        document.documentElement.classList.add('dark');
    }
    await initIdentity();
    loadMyProfile();
    startFeed();
    startRoomDirectory();
    const savedView = localStorage.getItem('pulse_view') || 'timeline';
    switchView(savedView);
    if (localStorage.getItem('active_room')) {
        switchView('rooms');
        setTimeout(() => restoreRoomAfterRefresh(), 1200);
    }
});

if ('serviceWorker' in navigator) {
    window.addEventListener('load', () => {
        navigator.serviceWorker.register('./sw.js')
            .then(() => console.log('[SW] Registered'))
            .catch(e => console.warn('[SW] Failed:', e));
    });
}

window.publishPost = publishPost;
window.likePost = likePost;
window.replyToPost = replyToPost;
window.confirmReply = confirmReply;
window.closeReplyModal = closeReplyModal;
window.toggleRoom = toggleRoom;
window.toggleMute = toggleMute;
window.joinDiscoveredRoom = joinDiscoveredRoom;
window.switchView = switchView;
window.toggleTheme = toggleTheme;
window.toggleSettings = toggleSettings;
window.exportKey = exportKey;
window.importKey = importKey;
window.copyNpub = copyNpub;
window.openProfileModal = openProfileModal;
window.closeProfileModal = closeProfileModal;
window.saveProfile = saveProfile;
window.previewProfilePicture = previewProfilePicture;
window.showToast = showToast;
