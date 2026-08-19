/* =========================================================
   Pulse - التطبيق الرئيسي (نسخة محسّنة بالكامل)
   نظام Nostr + المنشورات + غرف الصوت WebRTC
   مع صلاحيات مشرف (حذف محلي لأي منشور)
   ========================================================= */

// ============================
// 1. الثوابت والإعدادات
// ============================

const RELAYS = [
    'wss://relay.damus.io',
    'wss://relay.primal.net',
    'wss://nos.lol',
    'wss://relay.nostr.band'
];

const APP_TAG = 'pulse-platform';
const ROOM_EVENT_KIND = 20000;
const MAX_SEEN_EVENTS = 10000;
const MAX_RENDERED_POSTS = 500;
const MAX_DISCOVERED_ROOMS = 50;
const DISCOVERY_TAG = APP_TAG + ':room-directory';
const ROOM_PRESENCE_TTL_MS = 90 * 1000;
const INITIAL_FEED_LIMIT = 300;

// ============================
// 2. المشرف (Admin)
// ============================

const ADMIN_NSEC = 'nsec1f57x59vhhrlz0x6t8jrs6dmdr7xaf28g8kfh8d6yncf4lurrw4vss82h7s';
let adminPubkey = null;

// محاولة استخراج pubkey للمشرف من nsec
try {
    const decoded = NostrTools.nip19.decode(ADMIN_NSEC);
    if (decoded.type === 'nsec') {
        // تحويل Uint8Array إلى hex string
        const hexSk = Array.from(decoded.data).map(b => b.toString(16).padStart(2, '0')).join('');
        adminPubkey = NostrTools.getPublicKey(hexSk);
        console.log('[Admin] تم تحميل مفتاح المشرف:', adminPubkey);
    }
} catch (e) {
    console.warn('[Admin] فشل تحليل مفتاح المشرف:', e);
}

// ============================
// 3. الحالة العامة
// ============================

let secretKeyHex = null;
let pk = null;
let npub = null;
let usingNip07 = false;
const storageKey = 'pulse_nsec_hex';

const pool = new NostrTools.SimplePool();

// الحالة الأساسية
const seenEvents = new Set();
const renderedPosts = new Map();      // postId -> HTMLElement
const postScores = new Map();         // postId -> number
const profileCache = new Map();
const postStats = new Map();          // postId -> { likes, replies, createdAt, myLikeEventId }
const postContentMap = new Map();     // postId -> { content, created_at }

// نظام إعجابات حقيقي
const postLikers = new Map();         // postId -> Map(pubkey -> likeEventId)
const likeEventIndex = new Map();     // likeEventId -> { postId, pubkey }
const tombstonedEvents = new Set();   // eventIds اتحذفت

// ردود معلقة (لحل مشكلة الرفرش)
const pendingRepliesMap = new Map();  // rootId -> [event, ...]

function initPostState(id, createdAt) {
    postStats.set(id, { likes: 0, replies: 0, createdAt, myLikeEventId: null });
    postLikers.set(id, new Map());
}

let postsSubscription = null;
let reactionsSubscription = null;
let reactionResubscribeTimer = null;

function scheduleReactionResubscribe() {
    if (reactionResubscribeTimer) clearTimeout(reactionResubscribeTimer);
    reactionResubscribeTimer = setTimeout(() => {
        reactionResubscribeTimer = null;
        startReactionSubscription();
    }, 700);
}

// الغرف الصوتية
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

// تحميل المزيد
let oldestTimestamp = null;
let loadingMore = false;

// ============================
// 4. أدوات مساعدة
// ============================

const $ = id => document.getElementById(id);

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

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

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
        if (el?.remove) el.remove();
        map.delete(keys[i]);
    }
}

function getDisplayName(pubkey) {
    const cached = profileCache.get(pubkey);
    if (cached?.name) return cached.name.slice(0, 24);
    return pubkey.slice(0, 8) + '...';
}

// ============================
// 5. Toast
// ============================

function showToast(message, type = 'success') {
    const toast = $('toast');
    const icon = $('toast-icon');
    const msg = $('toast-msg');
    if (!toast || !icon || !msg) { console.log('[Toast]', message); return; }

    msg.textContent = message;
    icon.className = type === 'error' ? 'fas fa-exclamation-circle text-red-400' :
                     type === 'info'  ? 'fas fa-info-circle text-blue-400' :
                                        'fas fa-check-circle text-green-400';

    toast.classList.remove('hidden');
    clearTimeout(toast._timer);
    toast._timer = setTimeout(() => toast.classList.add('hidden'), 3500);
}

// ============================
// 6. الهوية Nostr
// ============================

async function initIdentity() {
    try {
        if (window.nostr?.getPublicKey) {
            try {
                pk = await window.nostr.getPublicKey();
                npub = NostrTools.nip19.npubEncode(pk);
                usingNip07 = true;
                secretKeyHex = null;
                updateIdentityUI();
                console.log('[Nostr] NIP-07');
                showToast('تم الاتصال بامتداد Nostr (NIP-07)', 'success');
                return;
            } catch (e) { console.warn('[Nostr] NIP-07 فشل:', e); }
        }

        let hexSk = localStorage.getItem(storageKey);
        const isValid = typeof hexSk === 'string' && hexSk.length === 64 && /^[0-9a-fA-F]{64}$/.test(hexSk);

        if (!isValid) {
            const generated = NostrTools.generateSecretKey();
            hexSk = Array.from(generated).map(b => b.toString(16).padStart(2, '0')).join('');
            localStorage.setItem(storageKey, hexSk);
            showToast('تم إنشاء هوية جديدة. احفظ مفتاحك!', 'info');
        }

        secretKeyHex = hexSk;
        pk = NostrTools.getPublicKey(secretKeyHex);
        npub = NostrTools.nip19.npubEncode(pk);
        usingNip07 = false;
        updateIdentityUI();
        console.log('[Nostr] هوية محلية');
    } catch (error) {
        console.error('[Nostr] فشل:', error);
        localStorage.removeItem(storageKey);
        showToast('خطأ في الهوية، سيتم إنشاء جديدة', 'error');
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
        badge.classList.toggle('hidden', !usingNip07);
        badge.textContent = 'NIP-07';
    }
}

async function signEvent(eventTemplate) {
    if (usingNip07 && window.nostr?.signEvent) {
        return await window.nostr.signEvent(eventTemplate);
    }
    if (!secretKeyHex) throw new Error('لا يوجد مفتاح توقيع');
    return NostrTools.finalizeEvent(eventTemplate, secretKeyHex);
}

// تصدير/استيراد المفاتيح
function exportKey() {
    if (usingNip07) { showToast('صدّر المفتاح من الامتداد نفسه', 'info'); return; }
    if (!secretKeyHex) { showToast('لا يوجد مفتاح للتصدير', 'error'); return; }
    try {
        const bytes = Uint8Array.from(secretKeyHex.match(/.{1,2}/g).map(b => parseInt(b, 16)));
        const nsec = NostrTools.nip19.nsecEncode(bytes);
        navigator.clipboard?.writeText(nsec).then(() => showToast('تم نسخ nsec', 'success'))
            .catch(() => prompt('انسخ nsec:', nsec));
    } catch (e) {
        prompt('انسخ المفتاح (hex):', secretKeyHex);
    }
}

function importKey() {
    if (usingNip07) { showToast('عطّل الامتداد أولاً', 'info'); return; }
    const input = prompt('الصق nsec أو المفتاح السري (64 حرف hex):');
    if (!input?.trim()) return;
    try {
        let hex = input.trim();
        if (hex.startsWith('nsec1')) {
            const decoded = NostrTools.nip19.decode(hex);
            if (decoded.type !== 'nsec') throw new Error('نوع غير صحيح');
            hex = Array.from(decoded.data).map(b => b.toString(16).padStart(2, '0')).join('');
        }
        if (!/^[0-9a-fA-F]{64}$/.test(hex)) throw new Error('صيغة غير صحيحة');
        localStorage.setItem(storageKey, hex);
        secretKeyHex = hex;
        pk = NostrTools.getPublicKey(secretKeyHex);
        npub = NostrTools.nip19.npubEncode(pk);
        usingNip07 = false;
        updateIdentityUI();
        showToast('تم استيراد المفتاح', 'success');
        // إعادة تحميل التغذية
        if (postsSubscription) { try { postsSubscription.close(); } catch(e) {} }
        seenEvents.clear();
        renderedPosts.clear();
        postScores.clear();
        postStats.clear();
        postContentMap.clear();
        pendingRepliesMap.clear();
        const container = $('feed-container');
        if (container) container.innerHTML = '';
        startFeed();
    } catch (error) {
        showToast('فشل الاستيراد: ' + getErrorMessage(error), 'error');
    }
}

function copyNpub() {
    if (!npub) return;
    navigator.clipboard?.writeText(npub).then(() => showToast('تم نسخ npub', 'success'))
        .catch(() => prompt('انسخ npub:', npub));
}

// ============================
// 7. الملف الشخصي (Profile)
// ============================

let myProfile = { name: '', picture: '', banner: '', about: '', location: '', website: '' };
let pendingAvatarFile = null, pendingBannerFile = null;
let pendingAvatarPreviewUrl = null, pendingBannerPreviewUrl = null;

const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
const ALLOWED_IMAGE_TYPES = ['image/jpeg', 'image/png', 'image/webp', 'image/gif'];

function revokePreview(url) {
    if (url?.startsWith('blob:')) { try { URL.revokeObjectURL(url); } catch(e) {} }
}

function validateImageFile(file) {
    if (!file) return 'لم يتم اختيار ملف';
    if (!ALLOWED_IMAGE_TYPES.includes(file.type)) return 'صيغة غير مدعومة';
    if (file.size > MAX_IMAGE_BYTES) return 'حجم الصورة كبير (الحد الأقصى 5MB)';
    return null;
}

async function compressImage(file, maxWidth, quality) {
    return new Promise((resolve, reject) => {
        const img = new Image();
        const objectUrl = URL.createObjectURL(file);
        img.onload = () => {
            try {
                const scale = Math.min(1, maxWidth / img.width);
                const w = Math.round(img.width * scale);
                const h = Math.round(img.height * scale);
                const canvas = document.createElement('canvas');
                canvas.width = w; canvas.height = h;
                const ctx = canvas.getContext('2d');
                ctx.drawImage(img, 0, 0, w, h);
                canvas.toBlob(blob => {
                    URL.revokeObjectURL(objectUrl);
                    if (!blob) { reject(new Error('فشل الضغط')); return; }
                    resolve(new File([blob], file.name.replace(/\..+$/, '.jpg'), { type: 'image/jpeg' }));
                }, 'image/jpeg', quality);
            } catch(e) { URL.revokeObjectURL(objectUrl); reject(e); }
        };
        img.onerror = () => { URL.revokeObjectURL(objectUrl); reject(new Error('تعذر قراءة الصورة')); };
        img.src = objectUrl;
    });
}

async function buildNip98AuthHeader(url, method) {
    const event = await signEvent({
        kind: 27235,
        created_at: Math.floor(Date.now() / 1000),
        tags: [['u', url], ['method', method]],
        content: ''
    });
    return `Nostr ${btoa(unescape(encodeURIComponent(JSON.stringify(event))))}`;
}

async function uploadFileToNostrBuild(file) {
    const uploadUrl = 'https://nostr.build/api/v2/upload/files';
    const form = new FormData();
    form.append('file[]', file);
    let authHeader = null;
    try { authHeader = await buildNip98AuthHeader(uploadUrl, 'POST'); } catch(e) {}
    const res = await fetch(uploadUrl, {
        method: 'POST',
        headers: authHeader ? { Authorization: authHeader } : undefined,
        body: form
    });
    if (!res.ok) {
        if (res.status === 401) throw new Error('رفض السيرفر (401) — تأكد من هويتك');
        throw new Error('فشل رفع الملف (' + res.status + ')');
    }
    const data = await res.json();
    const item = Array.isArray(data) ? data[0] : (data?.data?.[0] || data?.[0] || data);
    const url = item?.url || item?.nip94_event?.tags?.find(t => t[0] === 'url')?.[1] || item?.data?.url || null;
    if (!url) throw new Error('لم يُرجع السيرفر رابطًا صالحًا');
    return url;
}

async function uploadFiles(files) {
    const results = [];
    for (const file of files) {
        try {
            const url = await uploadFileToNostrBuild(file);
            results.push({ url, type: file.type });
        } catch(e) {
            console.warn('[Upload] فشل رفع ملف:', e);
            showToast('فشل رفع أحد الملفات', 'error');
        }
    }
    return results;
}

// ===== واجهة الملف الشخصي =====

function renderProfileImages() {
    const avatarImg = $('profile-avatar-img');
    const avatarLetter = $('profile-avatar-letter');
    const bannerImg = $('profile-banner-img');
    const bannerEmpty = $('profile-banner-empty');
    const removeBannerBtn = $('btn-remove-banner');

    const avatarSrc = pendingAvatarPreviewUrl || myProfile.picture || '';
    if (avatarImg && avatarLetter) {
        if (avatarSrc) {
            avatarImg.src = avatarSrc;
            avatarImg.classList.remove('hidden');
            avatarLetter.classList.add('hidden');
        } else {
            avatarImg.classList.add('hidden');
            avatarLetter.classList.remove('hidden');
            avatarLetter.textContent = (myProfile.name || 'P').slice(0, 1).toUpperCase();
        }
    }

    const bannerSrc = pendingBannerPreviewUrl || myProfile.banner || '';
    if (bannerImg && bannerEmpty) {
        if (bannerSrc) {
            bannerImg.src = bannerSrc;
            bannerImg.classList.remove('hidden');
            bannerEmpty.classList.add('hidden');
            removeBannerBtn?.classList.remove('hidden');
            removeBannerBtn?.classList.add('flex');
        } else {
            bannerImg.classList.add('hidden');
            bannerEmpty.classList.remove('hidden');
            removeBannerBtn?.classList.add('hidden');
            removeBannerBtn?.classList.remove('flex');
        }
    }
}

function onProfileNameInput() {
    const val = $('profile-name')?.value || '';
    const counter = $('name-count');
    if (counter) counter.textContent = String(val.length);
    const letter = $('profile-avatar-letter');
    if (letter && !myProfile.picture && !pendingAvatarPreviewUrl) {
        letter.textContent = (val.trim() || 'P').slice(0, 1).toUpperCase();
    }
}

function onProfileAboutInput() {
    const val = $('profile-about')?.value || '';
    const counter = $('about-count');
    if (counter) counter.textContent = String(val.length);
}

function openProfileModal() {
    const modal = $('profile-modal');
    if (!modal) return;

    pendingAvatarFile = null;
    pendingBannerFile = null;
    revokePreview(pendingAvatarPreviewUrl);
    revokePreview(pendingBannerPreviewUrl);
    pendingAvatarPreviewUrl = null;
    pendingBannerPreviewUrl = null;

    $('profile-name').value = myProfile.name || '';
    $('profile-about').value = myProfile.about || '';
    $('profile-location').value = myProfile.location || '';
    $('profile-website').value = myProfile.website || '';

    onProfileNameInput();
    onProfileAboutInput();
    renderProfileImages();
    $('profile-upload-status')?.classList.add('hidden');

    modal.classList.remove('hidden');
    $('settings-panel')?.classList.add('hidden');
}

function closeProfileModal() {
    $('profile-modal')?.classList.add('hidden');
    revokePreview(pendingAvatarPreviewUrl);
    revokePreview(pendingBannerPreviewUrl);
    pendingAvatarPreviewUrl = null;
    pendingBannerPreviewUrl = null;
    pendingAvatarFile = null;
    pendingBannerFile = null;
}

async function saveProfile() {
    if (!pk) { showToast('لا توجد هوية', 'error'); return; }

    const name = ($('profile-name')?.value || '').trim().slice(0, 50);
    const about = ($('profile-about')?.value || '').trim().slice(0, 160);
    const location = ($('profile-location')?.value || '').trim().slice(0, 30);
    const website = ($('profile-website')?.value || '').trim().slice(0, 100);

    if (!name) { showToast('الاسم مطلوب', 'error'); return; }
    if (website && !/^https?:\/\//i.test(website)) {
        showToast('الرابط يجب أن يبدأ بـ http:// أو https://', 'error');
        return;
    }

    const btn = $('btn-save-profile');
    if (btn) btn.disabled = true;

    try {
        let pictureUrl = myProfile.picture || '';
        let bannerUrl = myProfile.banner || '';

        if (pendingAvatarFile) {
            $('profile-upload-status').textContent = 'جاري رفع الصورة...';
            $('profile-upload-status').classList.remove('hidden');
            const compressed = await compressImage(pendingAvatarFile, 400, 0.85);
            pictureUrl = await uploadFileToNostrBuild(compressed);
        }
        if (pendingBannerFile) {
            $('profile-upload-status').textContent = 'جاري رفع الغلاف...';
            $('profile-upload-status').classList.remove('hidden');
            const compressed = await compressImage(pendingBannerFile, 1500, 0.82);
            bannerUrl = await uploadFileToNostrBuild(compressed);
        }

        $('profile-upload-status').textContent = 'جاري الحفظ...';
        $('profile-upload-status').classList.remove('hidden');

        const contentObj = { name, display_name: name, about: about || undefined, picture: pictureUrl || undefined, banner: bannerUrl || undefined, location: location || undefined, website: website || undefined };
        Object.keys(contentObj).forEach(k => { if (contentObj[k] === undefined || contentObj[k] === '') delete contentObj[k]; });

        const event = await signEvent({ kind: 0, created_at: Math.floor(Date.now() / 1000), tags: [], content: JSON.stringify(contentObj) });
        await pool.publish(RELAYS, event);

        myProfile = { name, about, picture: pictureUrl, banner: bannerUrl, location, website };
        profileCache.set(pk, { name, picture: pictureUrl || null, about: about || null });

        pendingAvatarFile = null;
        pendingBannerFile = null;
        revokePreview(pendingAvatarPreviewUrl);
        revokePreview(pendingBannerPreviewUrl);
        pendingAvatarPreviewUrl = null;
        pendingBannerPreviewUrl = null;

        updateHeaderAvatar();
        updateAvatarsInDom(pk);
        closeProfileModal();
        showToast('تم تحديث الملف الشخصي ✅', 'success');
    } catch (error) {
        console.error('[Profile] فشل:', error);
        showToast('فشل الحفظ: ' + getErrorMessage(error), 'error');
    } finally {
        if (btn) btn.disabled = false;
        $('profile-upload-status')?.classList.add('hidden');
    }
}

// ===== تحميل الملف الشخصي =====

function loadMyProfile() {
    if (!pk) return;
    let sub = null;
    try {
        sub = pool.subscribeMany(RELAYS, [{ kinds: [0], authors: [pk], limit: 1 }], {
            onevent: event => {
                try {
                    const meta = JSON.parse(event.content || '{}');
                    myProfile = {
                        name: meta.display_name || meta.name || '',
                        picture: meta.picture || '',
                        banner: meta.banner || '',
                        about: meta.about || '',
                        location: meta.location || '',
                        website: meta.website || meta.url || ''
                    };
                    profileCache.set(pk, { name: myProfile.name || null, picture: myProfile.picture || null, about: myProfile.about || null });
                    updateHeaderAvatar();
                    updateAvatarsInDom(pk);
                } catch(e) {}
            },
            oneose: () => { if (sub) try { sub.close(); } catch(e) {} }
        });
    } catch(e) { console.warn('[Profile] فشل تحميل الملف:', e); }
}

// ===== عرض الصورة الرمزية =====

function avatarHtml(pubkey, sizeClass) {
    const profile = profileCache.get(pubkey);
    const fallback = (pubkey || '؟').slice(0, 2).toUpperCase();
    if (profile?.picture) {
        return `<div class="avatar ${sizeClass} bg-gradient-to-br from-accent to-accent2 overflow-hidden p-0">
            <img src="${escapeHtml(profile.picture)}" alt="" class="w-full h-full object-cover"
                 onerror="this.parentElement.textContent='${escapeHtml(fallback)}'">
        </div>`;
    }
    return `<div class="avatar ${sizeClass} bg-gradient-to-br from-accent to-accent2">${escapeHtml(fallback)}</div>`;
}

function updateAvatarsInDom(pubkey) {
    const profile = profileCache.get(pubkey);
    const displayName = getDisplayName(pubkey);

    document.querySelectorAll(`.post-card[data-author="${pubkey}"]`).forEach(card => {
        const nameEl = card.querySelector('.author-name');
        if (nameEl && profile?.name) nameEl.textContent = displayName;
        const slot = card.querySelector('.avatar-slot');
        if (slot) slot.innerHTML = avatarHtml(pubkey, 'w-10 h-10 text-sm');
    });

    document.querySelectorAll(`.participant-avatar[data-pubkey="${pubkey}"]`).forEach(slot => {
        slot.innerHTML = avatarHtml(pubkey, 'w-12 h-12 text-sm');
    });

    if (pubkey === pk) updateHeaderAvatar();
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
        fb.textContent = (myProfile.name || pk || 'P').slice(0, 1).toUpperCase();
    }
}

// ===== جلب الملفات الشخصية (debounced) =====

let profileFetchQueue = [];
let profileFetchTimer = null;

function fetchProfiles(pubkeys) {
    const needed = pubkeys.filter(p => p && !profileCache.has(p));
    if (!needed.length) return;
    profileFetchQueue.push(...needed);
    clearTimeout(profileFetchTimer);
    profileFetchTimer = setTimeout(() => {
        const batch = profileFetchQueue.slice(0, 60);
        profileFetchQueue = [];
        if (!batch.length) return;
        try {
            const sub = pool.subscribeMany(RELAYS, [{ kinds: [0], authors: batch, limit: 60 }], {
                onevent: event => {
                    try {
                        const meta = JSON.parse(event.content || '{}');
                        profileCache.set(event.pubkey, {
                            name: meta.display_name || meta.name || null,
                            picture: meta.picture || null,
                            about: meta.about || null
                        });
                        updateAvatarsInDom(event.pubkey);
                    } catch(e) {}
                },
                oneose: () => { if (sub) try { sub.close(); } catch(e) {} }
            });
        } catch(e) { console.warn('[Profile] فشل جلب:', e); }
    }, 300);
}

// ============================
// 8. خوارزمية التوزين (Edge-like)
// ============================

function calculateScore(postId) {
    const stats = postStats.get(postId);
    if (!stats) return 0;
    const { likes, replies, createdAt } = stats;
    const now = Date.now() / 1000;
    const hours = Math.max(0.01, (now - createdAt) / 3600);
    return (likes * 1.5 + replies * 2.5) / Math.pow(hours + 2, 1.8);
}

function updatePostScore(postId) {
    const score = calculateScore(postId);
    postScores.set(postId, score);
    return score;
}

function reorderFeed() {
    const container = $('feed-container');
    if (!container) return;
    const cards = Array.from(container.querySelectorAll('.post-card'));
    if (cards.length < 2) return;
    cards.sort((a, b) => {
        const scoreA = postScores.get(a.dataset.postId) || 0;
        const scoreB = postScores.get(b.dataset.postId) || 0;
        return scoreB - scoreA;
    });
    const fragment = document.createDocumentFragment();
    cards.forEach(card => fragment.appendChild(card));
    container.appendChild(fragment);
}

// ============================
// 9. عرض الوسائط (الصور والفيديو)
// ============================

const MEDIA_ONLY_LINE_RE = /^(https?:\/\/[^\s<>"']+\.(jpe?g|png|gif|webp|svg|bmp|ico|mp4|webm|mov|avi|mkv|ogg)(\?[^\s<>"']*)?)$/i;

function extractMediaFromContent(content) {
    if (!content) return { text: '', mediaUrls: [] };
    const mediaUrls = [];
    const keptLines = [];
    for (const line of content.split('\n')) {
        const trimmed = line.trim();
        if (trimmed && MEDIA_ONLY_LINE_RE.test(trimmed)) {
            mediaUrls.push(trimmed);
        } else {
            keptLines.push(line);
        }
    }
    const text = keptLines.join('\n').replace(/\n{3,}/g, '\n\n').trim();
    return { text, mediaUrls };
}

function renderMediaContent(content) {
    if (!content) return '';

    let html = content;
    const placeholders = [];
    const stash = (tagHtml) => {
        const token = `\u0000MEDIA${placeholders.length}\u0000`;
        placeholders.push(tagHtml);
        return token;
    };

    html = html.replace(
        /(https?:\/\/[^\s<>"']+\.(jpe?g|png|gif|webp|svg|bmp|ico)(\?[^\s<>"']*)?)/gi,
        (match) => {
            const safeUrl = match.replace(/&/g, '&amp;');
            return stash(`<img src="${safeUrl}" alt="صورة" class="max-w-full rounded-xl my-2 max-h-[500px] object-contain border border-gray-200 dark:border-gray-700 shadow-sm cursor-pointer" loading="lazy" onclick="window.open('${safeUrl}', '_blank')" onerror="this.style.display='none'" />`);
        }
    );

    html = html.replace(
        /(https?:\/\/[^\s<>"']+\.(mp4|webm|mov|avi|mkv|ogg)(\?[^\s<>"']*)?)/gi,
        (match) => {
            const safeUrl = match.replace(/&/g, '&amp;');
            return stash(`<video src="${safeUrl}" controls class="max-w-full rounded-xl my-2 max-h-[500px] w-full border border-gray-200 dark:border-gray-700 shadow-sm" preload="metadata" playsinline></video>`);
        }
    );

    html = html.replace(
        /(?:https?:\/\/)?(?:www\.)?(?:youtube\.com\/watch\?v=|youtu\.be\/)([a-zA-Z0-9_-]{11})/gi,
        (_, vid) => stash(`<iframe class="w-full rounded-xl my-2 aspect-video border border-gray-200 dark:border-gray-700 shadow-sm" src="https://www.youtube.com/embed/${vid}" frameborder="0" allowfullscreen loading="lazy"></iframe>`)
    );

    html = html.replace(
        /(?:https?:\/\/)?(?:www\.)?vimeo\.com\/(\d+)/gi,
        (_, id) => stash(`<iframe class="w-full rounded-xl my-2 aspect-video border border-gray-200 dark:border-gray-700 shadow-sm" src="https://player.vimeo.com/video/${id}" frameborder="0" allowfullscreen loading="lazy"></iframe>`)
    );

    html = html.replace(
        /(https?:\/\/[^\s<>"']+)/gi,
        (match) => `<a href="${match}" target="_blank" rel="noopener noreferrer" class="text-accent hover:underline">${match}</a>`
    );

    html = html.replace(/\u0000MEDIA(\d+)\u0000/g, (_, i) => placeholders[Number(i)]);

    if (typeof DOMPurify !== 'undefined') {
        html = DOMPurify.sanitize(html, {
            ALLOWED_TAGS: ['img', 'video', 'iframe', 'a', 'p', 'br', 'strong', 'b', 'em', 'i', 'u', 's', 'ul', 'ol', 'li', 'blockquote', 'code', 'pre', 'span', 'div'],
            ALLOWED_ATTR: ['src', 'alt', 'class', 'onclick', 'controls', 'preload', 'playsinline', 'href', 'target', 'rel', 'frameborder', 'allowfullscreen', 'loading', 'width', 'height', 'style']
        });
    }

    return html;
}

// ============================
// 10. المنشورات (Feed)
// ============================

function startFeed() {
    console.log('[Feed] بدء الاشتراك');
    const loading = $('loading-feed');
    if (loading) loading.classList.remove('hidden');

    try {
        postsSubscription = pool.subscribeMany(RELAYS, [{ kinds: [1, 5], limit: INITIAL_FEED_LIMIT, '#t': [APP_TAG] }], {
            onevent: event => {
                if (!event?.id) return;
                if (event.kind === 5) { handleDeleteEvent(event); return; }
                const hasTag = event.tags?.some(t => t[0] === 't' && t[1] === APP_TAG);
                if (!hasTag) return;
                // معالجة الردود عبر handleIncomingReply بدلاً من عرضها كمنشورات
                if (isReplyEvent(event)) {
                    handleIncomingReply(event);
                    return;
                }
                if (seenEvents.has(event.id)) return;
                seenEvents.add(event.id);
                limitSet(seenEvents, MAX_SEEN_EVENTS);

                initPostState(event.id, event.created_at);
                updatePostScore(event.id);
                postContentMap.set(event.id, { content: event.content, created_at: event.created_at });
                renderPost(event);
                reorderFeed();
                scheduleReactionResubscribe();
            },
            oneose: () => {
                console.log('[Feed] تم التحميل الأولي');
                if (loading) loading.classList.add('hidden');
                // معالجة أي ردود معلقة بعد تحميل كل شيء
                processAllPendingReplies();
                startReactionSubscription();
                updateLoadMoreButton();
            },
            onclose: () => console.log('[Feed] اشتراك أغلق')
        });
    } catch (error) {
        console.error('[Feed] خطأ:', error);
        if (loading) loading.classList.add('hidden');
        showToast('تعذر الاتصال بشبكة المنشورات: ' + getErrorMessage(error), 'error');
    }
}

function isReplyEvent(event) {
    return event.tags?.some(tag => tag[0] === 'e' && tag[1]);
}

function getPostCard(postId) {
    return document.querySelector(`.post-card[data-post-id="${CSS.escape(postId)}"]`);
}

// إدراج بطاقة في المكان الصحيح حسب الوقت (الأحدث أولاً)
function insertPostCard(card) {
    const container = $('feed-container');
    if (!container) return;
    const postId = card.dataset.postId;
    const createdAt = postStats.get(postId)?.createdAt || 0;
    const cards = container.querySelectorAll('.post-card');
    let inserted = false;
    for (let c of cards) {
        const otherId = c.dataset.postId;
        const otherTime = postStats.get(otherId)?.createdAt || 0;
        if (createdAt > otherTime) {
            container.insertBefore(card, c);
            inserted = true;
            break;
        }
    }
    if (!inserted) container.appendChild(card);
}

function renderPost(event) {
    const container = $('feed-container');
    if (!container) return;
    if (renderedPosts.has(event.id)) return;

    const time = new Date(event.created_at * 1000).toLocaleString('ar-EG', {
        hour: '2-digit', minute: '2-digit', day: 'numeric', month: 'short'
    });
    const displayName = getDisplayName(event.pubkey);
    const isOwner = (event.pubkey === pk);
    const isAdmin = (pk === adminPubkey); // هل المستخدم الحالي هو المشرف؟

    // إذا كان المشرف، نعرض زر حذف لكل المنشورات، وإلا فقط للمالك
    const showDelete = isOwner || isAdmin;

    const contentHtml = renderMediaContent(event.content);

    const div = document.createElement('div');
    div.className = 'post-card bg-white dark:bg-cardDark rounded-3xl p-5 shadow-soft border border-gray-100 dark:border-gray-800 fade-in transition-all duration-200';
    div.dataset.postId = event.id;
    div.dataset.author = event.pubkey;

    div.innerHTML = `
        <div class="flex justify-between items-start mb-4">
            <div class="flex items-center gap-3 min-w-0">
                <div class="avatar-slot flex-shrink-0">${avatarHtml(event.pubkey, 'w-11 h-11 text-base')}</div>
                <div class="min-w-0 flex-1">
                    <div class="author-name font-bold text-sm dark:text-white truncate">${escapeHtml(displayName)}</div>
                    <div class="text-xs text-gray-400">${escapeHtml(time)}</div>
                </div>
            </div>
            ${showDelete ? `
            <div class="flex gap-1 flex-shrink-0">
                ${isOwner ? `<button onclick="editPost('${event.id}')" class="text-xs text-blue-500 hover:text-blue-700 transition p-1.5 rounded-lg hover:bg-blue-50 dark:hover:bg-blue-500/10" title="تعديل"><i class="fas fa-edit"></i></button>` : ''}
                <button onclick="deletePost('${event.id}', ${isAdmin ? 'true' : 'false'})" class="text-xs text-red-500 hover:text-red-700 transition p-1.5 rounded-lg hover:bg-red-50 dark:hover:bg-red-500/10" title="${isAdmin ? 'حذف (مشرف)' : 'حذف'}">
                    <i class="fas fa-trash"></i> ${isAdmin ? '<span class="text-[10px]">(مشرف)</span>' : ''}
                </button>
            </div>
            ` : ''}
        </div>
        <div class="post-content text-gray-800 dark:text-gray-200 leading-relaxed mb-4 whitespace-pre-wrap text-sm md:text-base break-words">${contentHtml}</div>
        <div class="flex items-center gap-5 text-gray-400 text-sm border-t border-gray-100 dark:border-gray-800 pt-3">
            <button class="like-button flex items-center gap-2 hover:text-red-500 transition" onclick="likePost('${event.id}', '${event.pubkey}')" data-liked="false" data-postid="${event.id}">
                <i class="far fa-heart"></i> <span>إعجاب</span> <span class="like-count" data-count="0">0</span>
            </button>
            <button class="reply-button flex items-center gap-2 hover:text-accent transition" onclick="replyToPost('${event.id}', '${event.pubkey}')" title="اكتب تعليقًا">
                <i class="far fa-comment"></i> <span>تعليق</span>
            </button>
            <button class="reply-toggle-button flex items-center gap-1.5 hover:text-accent hover:underline transition" onclick="toggleReplies('${event.id}')" title="عرض التعليقات">
                <span class="reply-count" data-count="0">0</span> <span>تعليق</span>
                <i class="fas fa-chevron-down text-[10px] reply-toggle-icon transition-transform duration-200"></i>
            </button>
        </div>
        <div class="replies-container hidden mt-3 space-y-2" data-replies="${event.id}"></div>
    `;

    renderedPosts.set(event.id, div);
    limitMap(renderedPosts, MAX_RENDERED_POSTS);
    insertPostCard(div);
    fetchProfiles([event.pubkey]);

    // بعد عرض المنشور، حاول معالجة أي ردود معلقة له
    processPendingReplies(event.id);
}

// ============================
// 11. حذف المنشور (مع صلاحيات المشرف)
// ============================

async function deletePost(postId, isAdminDelete = false) {
    if (!pk) { showToast('لا توجد هوية', 'error'); return; }
    const card = getPostCard(postId);
    if (!card) { showToast('المنشور غير موجود', 'error'); return; }
    const author = card.dataset.author;
    const isOwner = (author === pk);
    const isAdmin = (pk === adminPubkey);

    // التحقق من الصلاحية
    if (!isOwner && !isAdmin) {
        showToast('ليس لديك صلاحية حذف هذا المنشور', 'error');
        return;
    }

    // إذا كان المشرف وليس المالك، نؤكد مع رسالة تحذيرية
    if (isAdmin && !isOwner) {
        if (!confirm('أنت مشرف، هل تريد حذف هذا المنشور (محلياً فقط، لن يُحذف من الشبكة)؟')) return;
    } else {
        if (!confirm('هل أنت متأكد من حذف هذا المنشور؟')) return;
    }

    try {
        // إذا كان المالك، نحاول إرسال حدث حذف (kind 5) كما في السابق
        if (isOwner) {
            const event = await signEvent({ kind: 5, created_at: Math.floor(Date.now() / 1000), tags: [['e', postId]], content: '' });
            await pool.publish(RELAYS, event);
            showToast('تم حذف المنشور', 'success');
        } else {
            // المشرف: حذف محلي فقط، لا نرسل حدثاً
            showToast('تم حذف المنشور محلياً بواسطة المشرف', 'info');
        }
        // إزالة المنشور من الواجهة
        removePostFromUI(postId);
    } catch (error) {
        showToast('فشل الحذف: ' + getErrorMessage(error), 'error');
    }
}

function handleDeleteEvent(event) {
    const targetId = getTagValue(event.tags, 'e');
    if (!targetId) return;
    if (renderedPosts.has(targetId)) {
        const card = getPostCard(targetId);
        if (card && card.dataset.author === event.pubkey) removePostFromUI(targetId);
        return;
    }

    tombstonedEvents.add(targetId);
    limitSet(tombstonedEvents, MAX_SEEN_EVENTS);
    const info = likeEventIndex.get(targetId);
    if (!info) return;
    likeEventIndex.delete(targetId);

    const likers = postLikers.get(info.postId);
    if (!likers || likers.get(info.pubkey) !== targetId) return;
    likers.delete(info.pubkey);

    const postStat = postStats.get(info.postId);
    if (!postStat) return;
    if (info.pubkey === pk) postStat.myLikeEventId = null;
    updatePostScore(info.postId);
    syncLikeCountUI(info.postId);
    if (info.pubkey === pk) updateLikeUI(info.postId, false);
    reorderFeed();
}

function removePostFromUI(postId) {
    const card = getPostCard(postId);
    if (card) {
        card.remove();
        renderedPosts.delete(postId);
        postStats.delete(postId);
        postScores.delete(postId);
        postContentMap.delete(postId);
        seenEvents.delete(postId);
        postLikers.delete(postId);
        pendingRepliesMap.delete(postId);
    }
}

// ============================
// 12. تعديل المنشور
// ============================

let editingPostId = null;
let editAttachments = [];

function isVideoUrl(url) {
    return /\.(mp4|webm|mov|avi|mkv|ogg)(\?.*)?$/i.test(url || '');
}

function renderEditAttachmentPreviews() {
    const wrap = $('edit-attachment-preview');
    if (!wrap) return;
    if (!editAttachments.length) {
        wrap.innerHTML = '';
        wrap.classList.add('hidden');
        return;
    }
    wrap.classList.remove('hidden');
    wrap.innerHTML = editAttachments.map((att, i) => {
        const video = isVideoUrl(att.url);
        const media = video
            ? `<video src="${att.url}" class="w-full h-full object-cover pointer-events-none" muted></video>`
            : `<img src="${att.url}" class="w-full h-full object-cover pointer-events-none" alt="معاينة مرفق" />`;
        return `
            <div class="relative w-20 h-20 rounded-xl overflow-hidden border border-gray-200 dark:border-gray-700 flex-shrink-0 bg-gray-100 dark:bg-gray-800">
                ${media}
                <button type="button" onclick="removeEditAttachment(${i})"
                        class="absolute top-1 left-1 w-5 h-5 bg-black/60 text-white rounded-full flex items-center justify-center text-[10px] hover:bg-black/80 transition"
                        title="إزالة المرفق">
                    <i class="fas fa-times"></i>
                </button>
                ${video ? '<div class="absolute bottom-1 right-1 text-white text-[10px] bg-black/60 rounded px-1"><i class="fas fa-video"></i></div>' : ''}
            </div>
        `;
    }).join('');
}

function removeEditAttachment(index) {
    editAttachments.splice(index, 1);
    renderEditAttachmentPreviews();
}

function triggerEditFileUpload() {
    document.getElementById('edit-file-input')?.click();
}

async function handleEditFileSelect(event) {
    const files = event.target.files;
    if (!files || files.length === 0) return;
    showToast('جاري رفع الملفات...', 'info');
    const uploaded = await uploadFiles(Array.from(files));
    event.target.value = '';
    if (uploaded.length === 0) { showToast('فشل رفع الملفات', 'error'); return; }
    editAttachments.push(...uploaded);
    renderEditAttachmentPreviews();
    showToast(`تم رفع ${uploaded.length} ملف(ات)`, 'success');
}

function editPost(postId) {
    const data = postContentMap.get(postId);
    if (!data) { showToast('تعذر العثور على المحتوى', 'error'); return; }
    const modal = $('edit-modal');
    const textarea = $('edit-input');
    if (!modal || !textarea) { showToast('مودال التعديل غير جاهز', 'error'); return; }
    editingPostId = postId;

    const { text, mediaUrls } = extractMediaFromContent(data.content);
    textarea.value = text;
    editAttachments = mediaUrls.map(url => ({ url, type: isVideoUrl(url) ? 'video/*' : 'image/*' }));
    renderEditAttachmentPreviews();

    modal.classList.remove('hidden');
    setTimeout(() => textarea.focus(), 50);
}

function closeEditModal() {
    $('edit-modal')?.classList.add('hidden');
    editingPostId = null;
    editAttachments = [];
    renderEditAttachmentPreviews();
}

async function confirmEdit() {
    if (!editingPostId) return;
    const textarea = $('edit-input');
    const text = (textarea?.value || '').trim();
    if (!text && editAttachments.length === 0) { showToast('المحتوى لا يمكن أن يكون فارغاً', 'error'); return; }

    const mediaUrls = editAttachments.map(a => a.url);
    const newContent = [text, ...mediaUrls].filter(Boolean).join('\n');

    const oldPostId = editingPostId;
    try {
        const deleteEvent = await signEvent({ kind: 5, created_at: Math.floor(Date.now() / 1000), tags: [['e', oldPostId]], content: '' });
        await pool.publish(RELAYS, deleteEvent);

        const newEvent = await signEvent({ kind: 1, created_at: Math.floor(Date.now() / 1000), tags: [['t', APP_TAG]], content: newContent });
        await pool.publish(RELAYS, newEvent);

        const oldCard = getPostCard(oldPostId);
        if (oldCard) {
            oldCard.remove();
            renderedPosts.delete(oldPostId);
            postStats.delete(oldPostId);
            postLikers.delete(oldPostId);
            postScores.delete(oldPostId);
            postContentMap.delete(oldPostId);
            seenEvents.delete(oldPostId);
            pendingRepliesMap.delete(oldPostId);

            initPostState(newEvent.id, newEvent.created_at);
            updatePostScore(newEvent.id);
            postContentMap.set(newEvent.id, { content: newEvent.content, created_at: newEvent.created_at });
            renderPost(newEvent);
            reorderFeed();
            showToast('تم تعديل المنشور ✅', 'success');
        } else {
            seenEvents.add(newEvent.id);
            initPostState(newEvent.id, newEvent.created_at);
            updatePostScore(newEvent.id);
            postContentMap.set(newEvent.id, { content: newEvent.content, created_at: newEvent.created_at });
            renderPost(newEvent);
            reorderFeed();
            showToast('تم التعديل ونشر نسخة جديدة', 'success');
        }
        closeEditModal();
    } catch (error) {
        showToast('فشل التعديل: ' + getErrorMessage(error), 'error');
    }
}

// ============================
// 13. نشر منشور مع رفع الملفات
// ============================

let pendingAttachments = [];

function triggerFileUpload() {
    document.getElementById('file-input')?.click();
}

function isVideoAttachment(att) {
    if (att.type?.startsWith('video/')) return true;
    return /\.(mp4|webm|mov|avi|mkv|ogg)(\?.*)?$/i.test(att.url || '');
}

function renderAttachmentPreviews() {
    const wrap = $('attachment-preview');
    if (!wrap) return;
    if (!pendingAttachments.length) {
        wrap.innerHTML = '';
        wrap.classList.add('hidden');
        return;
    }
    wrap.classList.remove('hidden');
    wrap.innerHTML = pendingAttachments.map((att, i) => {
        const video = isVideoAttachment(att);
        const media = video
            ? `<video src="${att.url}" class="w-full h-full object-cover pointer-events-none" muted></video>`
            : `<img src="${att.url}" class="w-full h-full object-cover pointer-events-none" alt="معاينة مرفق" />`;
        return `
            <div class="relative w-20 h-20 rounded-xl overflow-hidden border border-gray-200 dark:border-gray-700 flex-shrink-0 bg-gray-100 dark:bg-gray-800">
                ${media}
                <button type="button" onclick="removeAttachment(${i})"
                        class="absolute top-1 left-1 w-5 h-5 bg-black/60 text-white rounded-full flex items-center justify-center text-[10px] hover:bg-black/80 transition"
                        title="إزالة المرفق">
                    <i class="fas fa-times"></i>
                </button>
                ${video ? '<div class="absolute bottom-1 right-1 text-white text-[10px] bg-black/60 rounded px-1"><i class="fas fa-video"></i></div>' : ''}
            </div>
        `;
    }).join('');
}

function removeAttachment(index) {
    pendingAttachments.splice(index, 1);
    renderAttachmentPreviews();
}

async function handleFileSelect(event) {
    const files = event.target.files;
    if (!files || files.length === 0) return;
    showToast('جاري رفع الملفات...', 'info');
    const uploaded = await uploadFiles(Array.from(files));
    event.target.value = '';
    if (uploaded.length === 0) { showToast('فشل رفع الملفات', 'error'); return; }
    pendingAttachments.push(...uploaded);
    renderAttachmentPreviews();
    showToast(`تم رفع ${uploaded.length} ملف(ات)`, 'success');
}

async function publishPost() {
    const input = $('post-input');
    if (!input) { showToast('حقل الكتابة غير موجود', 'error'); return; }
    const text = (input.value || '').trim();
    if (!text && pendingAttachments.length === 0) { showToast('اكتب شيئًا أو أرفق صورة/فيديو قبل النشر', 'error'); return; }
    if (text.length > 4000) { showToast('النص طويل جدًا', 'error'); return; }

    const mediaUrls = pendingAttachments.map(a => a.url);
    const content = [text, ...mediaUrls].filter(Boolean).join('\n');

    try {
        const event = await signEvent({ kind: 1, created_at: Math.floor(Date.now() / 1000), tags: [['t', APP_TAG]], content });
        if (!seenEvents.has(event.id)) {
            seenEvents.add(event.id);
            initPostState(event.id, event.created_at);
            postContentMap.set(event.id, { content: event.content, created_at: event.created_at });
            updatePostScore(event.id);
            renderPost(event);
            reorderFeed();
            scheduleReactionResubscribe();
        }
        await pool.publish(RELAYS, event);
        input.value = '';
        pendingAttachments = [];
        renderAttachmentPreviews();
        showToast('تم النشر بنجاح', 'success');
    } catch (error) {
        showToast('فشل النشر: ' + getErrorMessage(error), 'error');
    }
}

// ============================
// 14. الإعجابات والردود
// ============================

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

function toggleReplies(postId) {
    const card = getPostCard(postId);
    if (!card) return;
    const container = card.querySelector(`[data-replies="${CSS.escape(postId)}"]`);
    const toggleBtn = card.querySelector('.reply-toggle-button');
    const icon = toggleBtn?.querySelector('.reply-toggle-icon');
    if (!container) return;
    const willShow = container.classList.contains('hidden');
    container.classList.toggle('hidden');
    if (icon) icon.classList.toggle('rotate-180', willShow);
}

function updateLikeUI(postId, liked) {
    const stats = getReactionStats(postId);
    if (!stats) return;
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

function syncLikeCountUI(postId) {
    const stats = getReactionStats(postId);
    const likers = postLikers.get(postId);
    const postStat = postStats.get(postId);
    if (!likers || !postStat) return;
    postStat.likes = likers.size;
    if (stats?.likeCount) {
        stats.likeCount.dataset.count = String(postStat.likes);
        stats.likeCount.textContent = String(postStat.likes);
    }
}

async function likePost(targetId, targetPubkey) {
    const stats = getReactionStats(targetId);
    if (!stats) { showToast('تعذر العثور على المنشور', 'error'); return; }
    const postStat = postStats.get(targetId);
    if (!postStat) return;
    let likers = postLikers.get(targetId);
    if (!likers) { likers = new Map(); postLikers.set(targetId, likers); }

    if (stats.likeButton.dataset.liked === 'true') {
        if (postStat.myLikeEventId) {
            try {
                const deleteEvent = await signEvent({ kind: 5, created_at: Math.floor(Date.now() / 1000), tags: [['e', postStat.myLikeEventId]], content: '' });
                await pool.publish(RELAYS, deleteEvent);
                likeEventIndex.delete(postStat.myLikeEventId);
                likers.delete(pk);
                postStat.myLikeEventId = null;
                updatePostScore(targetId);
                updateLikeUI(targetId, false);
                syncLikeCountUI(targetId);
                reorderFeed();
                showToast('تم إلغاء الإعجاب', 'info');
            } catch (error) {
                showToast('فشل إلغاء الإعجاب: ' + getErrorMessage(error), 'error');
            }
        }
        return;
    }

    if (likers.has(pk)) { updateLikeUI(targetId, true); syncLikeCountUI(targetId); return; }

    try {
        const likeEvent = await signEvent({ kind: 7, created_at: Math.floor(Date.now() / 1000), tags: [['e', targetId], ['p', targetPubkey]], content: '+' });
        await pool.publish(RELAYS, likeEvent);
        likers.set(pk, likeEvent.id);
        likeEventIndex.set(likeEvent.id, { postId: targetId, pubkey: pk });
        postStat.myLikeEventId = likeEvent.id;
        updatePostScore(targetId);
        updateLikeUI(targetId, true);
        syncLikeCountUI(targetId);
        stats.likeButton.classList.add('scale-110');
        setTimeout(() => stats.likeButton.classList.remove('scale-110'), 180);
        reorderFeed();
        showToast('تم الإعجاب ❤️', 'success');
    } catch (error) {
        showToast('فشل الإعجاب: ' + getErrorMessage(error), 'error');
    }
}

function startReactionSubscription() {
    const postIds = Array.from(renderedPosts.keys());
    if (!postIds.length) return;
    if (reactionsSubscription) try { reactionsSubscription.close(); } catch(e) {}
    try {
        reactionsSubscription = pool.subscribeMany(RELAYS, [{ kinds: [7, 1, 5], '#e': postIds, limit: 500 }], {
            onevent: event => {
                if (!event?.id) return;
                if (event.kind === 7) handleIncomingLike(event);
                if (event.kind === 1) handleIncomingReply(event);
                if (event.kind === 5) handleDeleteEvent(event);
            },
            oneose: () => console.log('[Reactions] تم التحميل')
        });
    } catch(e) { console.error('[Reactions] خطأ:', e); }
}

function handleIncomingLike(event) {
    if (seenEvents.has(event.id)) return;
    seenEvents.add(event.id);
    limitSet(seenEvents, MAX_SEEN_EVENTS);
    if (tombstonedEvents.has(event.id)) return;

    const targetId = getTagValue(event.tags, 'e');
    if (!targetId) return;
    const postStat = postStats.get(targetId);
    if (!postStat) return;

    let likers = postLikers.get(targetId);
    if (!likers) { likers = new Map(); postLikers.set(targetId, likers); }
    if (likers.has(event.pubkey)) return;

    likers.set(event.pubkey, event.id);
    likeEventIndex.set(event.id, { postId: targetId, pubkey: event.pubkey });
    if (event.pubkey === pk) postStat.myLikeEventId = event.id;

    updatePostScore(targetId);
    syncLikeCountUI(targetId);
    if (event.pubkey === pk) updateLikeUI(targetId, true);
    reorderFeed();
}

function getTagValue(tags, name) {
    if (!Array.isArray(tags)) return null;
    const tag = tags.find(t => t[0] === name);
    return tag ? tag[1] : null;
}

function getReplyTargets(tags) {
    if (!Array.isArray(tags)) return { rootId: null, parentId: null };
    const eTags = tags.filter(t => t[0] === 'e' && t[1]);
    if (!eTags.length) return { rootId: null, parentId: null };
    const rootTag = eTags.find(t => t[3] === 'root');
    const replyTag = eTags.find(t => t[3] === 'reply');
    if (rootTag) {
        return { rootId: rootTag[1], parentId: replyTag ? replyTag[1] : rootTag[1] };
    }
    return { rootId: eTags[0][1], parentId: eTags[0][1] };
}

// ===== معالجة الردود المعلقة =====

function processAllPendingReplies() {
    const keys = Array.from(pendingRepliesMap.keys());
    for (const rootId of keys) {
        processPendingReplies(rootId);
    }
}

function processPendingReplies(postId) {
    if (!pendingRepliesMap.has(postId)) return;
    const replies = pendingRepliesMap.get(postId);
    const toRemove = [];
    for (let i = 0; i < replies.length; i++) {
        const event = replies[i];
        const { rootId, parentId } = getReplyTargets(event.tags);
        if (attemptRenderReply(event, rootId, parentId)) {
            toRemove.push(i);
        }
    }
    for (let i = toRemove.length - 1; i >= 0; i--) {
        replies.splice(toRemove[i], 1);
    }
    if (replies.length === 0) pendingRepliesMap.delete(postId);
}

function attemptRenderReply(event, rootId, parentId) {
    const rootCard = getPostCard(rootId);
    if (!rootCard) return false;

    let container = null;
    if (parentId && parentId !== rootId) {
        const parentElement = document.querySelector(`[data-reply-id="${CSS.escape(parentId)}"]`);
        if (parentElement) {
            container = parentElement.querySelector('.nested-replies');
            if (!container) {
                container = document.createElement('div');
                container.className = 'nested-replies mt-2 space-y-2 mr-4 border-r-2 border-accent/20 pr-3';
                parentElement.appendChild(container);
            }
        }
    }
    if (!container) {
        container = rootCard.querySelector(`[data-replies="${CSS.escape(rootId)}"]`);
    }
    if (!container) return false;

    if (document.querySelector(`[data-reply-id="${CSS.escape(event.id)}"]`)) return true;

    const reply = document.createElement('div');
    reply.dataset.replyId = event.id;
    reply.className = 'bg-gray-50 dark:bg-gray-800/50 rounded-xl p-3 text-sm border-r-2 border-accent/30 mr-2';
    reply.innerHTML = `
        <div class="flex items-center gap-2 mb-1">
            <div class="avatar-slot">${avatarHtml(event.pubkey, 'w-6 h-6 text-xs')}</div>
            <span class="text-xs font-bold text-gray-700 dark:text-gray-300">${escapeHtml(getDisplayName(event.pubkey))}</span>
        </div>
        <div class="text-gray-700 dark:text-gray-200 mr-2">${escapeHtml(event.content)}</div>
        <button onclick="replyToComment('${event.id}', '${rootId}', '${event.pubkey}')" class="text-xs text-accent hover:underline mt-1 mr-2"><i class="fas fa-reply"></i> رد</button>
    `;
    container.appendChild(reply);
    fetchProfiles([event.pubkey]);

    const stats = getReactionStats(rootId);
    if (stats) {
        const current = Number(stats.replyCount.dataset.count || 0);
        stats.replyCount.dataset.count = String(current + 1);
        stats.replyCount.textContent = String(current + 1);
        const postStat = postStats.get(rootId);
        if (postStat) postStat.replies += 1;
        updatePostScore(rootId);
    }

    processPendingReplies(event.id);

    if (event.pubkey === pk) {
        const topContainer = rootCard.querySelector(`[data-replies="${CSS.escape(rootId)}"]`);
        const toggleIcon = rootCard.querySelector('.reply-toggle-button .reply-toggle-icon');
        if (topContainer?.classList.contains('hidden')) {
            topContainer.classList.remove('hidden');
            toggleIcon?.classList.add('rotate-180');
        }
    }

    reorderFeed();
    return true;
}

function handleIncomingReply(event) {
    const { rootId, parentId } = getReplyTargets(event.tags);
    if (!rootId) return;

    if (!pendingRepliesMap.has(rootId)) pendingRepliesMap.set(rootId, []);
    const existing = pendingRepliesMap.get(rootId).some(e => e.id === event.id);
    if (!existing) {
        pendingRepliesMap.get(rootId).push(event);
    }

    attemptRenderReply(event, rootId, parentId);
}

// ============================
// 15. الردود المتداخلة (Reply to Comment)
// ============================

let pendingReply = null;

async function replyToComment(replyToId, rootPostId, targetPubkey) {
    const modal = $('reply-modal');
    const textarea = $('reply-input');
    if (modal && textarea) {
        pendingReply = { targetId: replyToId, rootId: rootPostId, targetPubkey, isCommentReply: true };
        textarea.value = '';
        modal.classList.remove('hidden');
        setTimeout(() => textarea.focus(), 50);
        return;
    }
    const content = prompt('اكتب ردك على هذا التعليق:');
    if (!content?.trim()) return;
    await sendReplyWithRoot(replyToId, targetPubkey, content.trim(), rootPostId);
}

async function confirmReply() {
    if (!pendingReply) return;
    const textarea = $('reply-input');
    const content = (textarea?.value || '').trim();
    if (!content) { showToast('اكتب ردًا', 'error'); return; }
    const { targetId, targetPubkey, rootId, isCommentReply } = pendingReply;
    closeReplyModal();
    if (isCommentReply) {
        await sendReplyWithRoot(targetId, targetPubkey, content, rootId);
    } else {
        await sendReply(targetId, targetPubkey, content);
    }
}

async function sendReplyWithRoot(replyToId, targetPubkey, content, rootId) {
    try {
        const event = await signEvent({
            kind: 1,
            created_at: Math.floor(Date.now() / 1000),
            tags: [
                ['e', replyToId, '', 'reply'],
                ['e', rootId, '', 'root'],
                ['p', targetPubkey],
                ['t', APP_TAG]
            ],
            content
        });
        handleIncomingReply(event);
        await pool.publish(RELAYS, event);
        showToast('تم إرسال الرد', 'success');
    } catch (error) {
        showToast('فشل إرسال الرد: ' + getErrorMessage(error), 'error');
    }
}

async function sendReply(targetId, targetPubkey, content) {
    try {
        const event = await signEvent({
            kind: 1,
            created_at: Math.floor(Date.now() / 1000),
            tags: [['e', targetId, '', 'reply'], ['p', targetPubkey], ['t', APP_TAG]],
            content
        });
        handleIncomingReply(event);
        await pool.publish(RELAYS, event);
        showToast('تم إرسال الرد', 'success');
    } catch (error) {
        showToast('فشل إرسال الرد: ' + getErrorMessage(error), 'error');
    }
}

async function replyToPost(targetId, targetPubkey) {
    const modal = $('reply-modal');
    const textarea = $('reply-input');
    if (modal && textarea) {
        pendingReply = { targetId, targetPubkey, rootId: targetId, isCommentReply: false };
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

// ============================
// 16. غرف الصوت WebRTC (مختصرة)
// ============================

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
        if (peer && !peer.destroyed) { resolve(peer); return; }
        const peerId = 'pulse-' + (pk || 'anon').slice(0, 8) + '-' + Math.random().toString(36).slice(2, 8);
        let settled = false;
        try {
            peer = new Peer(peerId, { host: '0.peerjs.com', port: 443, secure: true, path: '/', debug: 1, config: WEBRTC_CONFIG });
            peer.on('open', id => { myPeerId = id; if (!settled) { settled = true; resolve(peer); } });
            peer.on('call', call => handleIncomingCall(call));
            peer.on('error', error => { if (!settled) { settled = true; reject(error); } handlePeerError(error); });
            peer.on('disconnected', () => showToast('انقطع اتصال الإشارة الصوتية', 'error'));
        } catch (error) { reject(error); }
    });
}

function handlePeerError(error) {
    const type = error?.type || '';
    const msg = getErrorMessage(error);
    if (type === 'network' || type === 'server-error' || type === 'socket-error') showToast('مشكلة في الشبكة: ' + msg, 'error');
    else if (type === 'unavailable-id') showToast('المعرف مستخدم، حاول مرة أخرى', 'error');
    else if (type === 'browser-incompatible') showToast('المتصفح لا يدعم WebRTC', 'error');
    else showToast('خطأ WebRTC: ' + msg, 'error');
}

async function toggleRoom(forceLeave = false) {
    if (forceLeave) { await leaveRoom(); return; }
    if (isJoiningRoom) return;
    if (currentRoom) { await leaveRoom(); return; }
    const input = $('room-input');
    if (!input) return;
    const roomName = safeRoomName(input.value);
    if (!roomName) { showToast('اكتب اسم الغرفة أولاً', 'error'); return; }
    await joinRoom(roomName);
}

async function joinRoom(roomName) {
    if (isJoiningRoom) return;
    isJoiningRoom = true;
    try {
        if (!navigator.mediaDevices?.getUserMedia) throw new Error('المتصفح لا يدعم getUserMedia');
        showToast('جاري تشغيل الميكروفون...', 'info');
        try {
            localStream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1 } });
        } catch (micError) {
            if (micError.name === 'NotAllowedError') throw new Error('تم رفض صلاحية الميكروفون');
            if (micError.name === 'NotFoundError') throw new Error('لم يتم العثور على ميكروفون');
            if (micError.name === 'NotReadableError') throw new Error('الميكروفون مستخدم');
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
        console.error('[Room] فشل:', error);
        showToast('فشل دخول الغرفة: ' + getErrorMessage(error), 'error');
        cleanupRoomResources(false);
    } finally { isJoiningRoom = false; }
}

function updateRoomUI(joined) {
    const btn = $('btn-join-room');
    const input = $('room-input');
    const activeUi = $('active-room-ui');
    const directoryUi = $('live-rooms-section');
    if (joined) {
        activeUi?.classList.remove('hidden');
        directoryUi?.classList.add('hidden');
        if (btn) { btn.textContent = 'مغادرة'; btn.classList.remove('bg-white', 'text-accent'); btn.classList.add('bg-red-500', 'text-white'); }
        if (input) input.disabled = true;
        if ($('current-room-name')) $('current-room-name').textContent = `غرفة: ${currentRoom}`;
    } else {
        activeUi?.classList.add('hidden');
        directoryUi?.classList.remove('hidden');
        if (btn) { btn.textContent = 'دخول'; btn.classList.remove('bg-red-500', 'text-white'); btn.classList.add('bg-white', 'text-accent'); }
        if (input) input.disabled = false;
    }
}

function roomTag() { return `${APP_TAG}:voice:${safeRoomName(currentRoom)}`; }

async function announcePresence() {
    if (!currentRoom || !myPeerId) return;
    const event = await signEvent({
        kind: ROOM_EVENT_KIND,
        created_at: Math.floor(Date.now() / 1000),
        tags: [['t', roomTag()], ['t', DISCOVERY_TAG], ['room', safeRoomName(currentRoom)]],
        content: JSON.stringify({ peerId: myPeerId, room: safeRoomName(currentRoom), npub, timestamp: Date.now() })
    });
    await pool.publish(RELAYS, event).catch(e => console.error('[Nostr Room] فشل presence:', e));
}

function listenForPeers() {
    if (!currentRoom) return;
    if (roomSubscription) try { roomSubscription.close(); } catch(e) {}
    try {
        roomSubscription = pool.subscribeMany(RELAYS, [{ kinds: [ROOM_EVENT_KIND], '#t': [roomTag()], limit: 100 }], {
            onevent: event => handleRoomPresence(event),
            oneose: () => {},
            onclose: () => {}
        });
    } catch(e) { showToast('فشل اكتشاف المشاركين: ' + getErrorMessage(e), 'error'); }
}

function handleRoomPresence(event) {
    if (!currentRoom || !event?.content || event.pubkey === pk) return;
    let data;
    try { data = JSON.parse(event.content); } catch(e) { return; }
    if (!data.peerId) return;
    if (data.room && safeRoomName(data.room) !== safeRoomName(currentRoom)) return;
    if (announcedPeers.has(data.peerId)) return;
    if (activeCalls.size >= 5) return;
    announcedPeers.add(data.peerId);
    if (myPeerId && myPeerId < data.peerId) connectToPeer(data.peerId, data.npub || data.peerId);
}

function connectToPeer(targetPeerId, displayName) {
    if (!peer || peer.destroyed || !localStream || !currentRoom) return;
    if (targetPeerId === myPeerId) return;
    if (activeCalls.has(targetPeerId)) return;
    try {
        const call = peer.call(targetPeerId, localStream, { metadata: { room: currentRoom, caller: myPeerId } });
        if (!call) return;
        handleCallEvents(call, displayName);
    } catch(e) { showToast('تعذر بدء الاتصال مع مشارك', 'error'); }
}

function handleIncomingCall(call) {
    if (!currentRoom || !localStream) { try { call.close(); } catch(e) {} return; }
    if (activeCalls.has(call.peer)) { try { call.close(); } catch(e) {} return; }
    try {
        call.answer(localStream);
        handleCallEvents(call, call.peer);
    } catch(e) { try { call.close(); } catch(e) {} }
}

function handleCallEvents(call, displayName) {
    if (!call) return;
    const peerId = call.peer;
    activeCalls.set(peerId, call);
    call.on('stream', stream => addPeerAudio(stream, peerId, displayName));
    call.on('close', () => removePeerCall(peerId));
    call.on('error', () => { showToast('انقطع اتصال مشارك', 'error'); removePeerCall(peerId); });
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
    audio.play().catch(() => {
        showToast('المتصفح منع تشغيل الصوت', 'error');
        document.addEventListener('click', () => audio.play().catch(() => {}), { once: true });
    });
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
    div.className = 'flex items-center gap-2 bg-gray-50 dark:bg-gray-800/50 p-2 rounded-lg';
    div.innerHTML = `<div class="w-2 h-2 bg-green-500 rounded-full animate-pulse"></div><span class="text-sm">${escapeHtml(String(displayName || peerId).slice(0, 16))}</span>`;
    list.appendChild(div);
}

function removePeerCall(peerId) {
    const audio = document.getElementById(`audio-${peerId}`);
    if (audio) { try { audio.pause(); } catch(e) {} audio.srcObject = null; audio.remove(); }
    const participant = document.getElementById(`participant-${peerId}`);
    if (participant) participant.remove();
    activeCalls.delete(peerId);
    updatePeerCount();
}

function updatePeerCount() {
    const count = $('peers-list')?.children.length || activeCalls.size;
    const countElement = $('peer-count');
    if (countElement) countElement.textContent = `الأشخاص: ${count}`;
}

function toggleMute() {
    if (!localStream) { showToast('لا يوجد ميكروفون نشط', 'error'); return; }
    const tracks = localStream.getAudioTracks();
    if (!tracks.length) { showToast('لم يتم العثور على مسار صوتي', 'error'); return; }
    isMuted = !isMuted;
    tracks.forEach(track => { track.enabled = !isMuted; });
    const btn = $('btn-mute');
    if (btn) {
        btn.innerHTML = isMuted ? '<i class="fas fa-microphone-slash text-red-500"></i>' : '<i class="fas fa-microphone"></i>';
        btn.classList.toggle('bg-red-100', isMuted);
        btn.classList.toggle('text-red-500', isMuted);
    }
    showToast(isMuted ? 'تم كتم الميكروفون' : 'تم تشغيل الميكروفون', 'success');
}

// دوال مساعدة للغرف
function startBackgroundAudioEngine() {
    try {
        if (!bgAudioContext) {
            const AudioContext = window.AudioContext || window.webkitAudioContext;
            if (!AudioContext) return;
            bgAudioContext = new AudioContext();
            if (bgAudioContext.state === 'suspended') bgAudioContext.resume().catch(() => {});
            const osc = bgAudioContext.createOscillator();
            const gain = bgAudioContext.createGain();
            gain.gain.value = 0.00001;
            osc.connect(gain);
            gain.connect(bgAudioContext.destination);
            osc.start();
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
    } catch(e) { console.error('[Audio] KeepAlive Error:', e); }
}

async function requestSystemLock() {
    try { if ('wakeLock' in navigator) wakeLock = await navigator.wakeLock.request('screen'); } catch(e) {}
}

function setupVAD() {
    if (!localStream) return;
    try {
        const AudioContext = window.AudioContext || window.webkitAudioContext;
        if (!AudioContext) return;
        const ctx = new AudioContext();
        const source = ctx.createMediaStreamSource(localStream);
        const analyser = ctx.createAnalyser();
        analyser.fftSize = 256;
        source.connect(analyser);
        const data = new Uint8Array(analyser.frequencyBinCount);
        const interval = setInterval(() => {
            if (!currentRoom) { clearInterval(interval); try { ctx.close(); } catch(e) {} return; }
            if (isMuted) return;
            analyser.getByteFrequencyData(data);
            const vol = data.reduce((s, v) => s + v, 0) / data.length;
            const status = $('vad-status');
            if (status) status.textContent = vol > 12 ? 'الحالة: تتحدث الآن 🎙️' : 'الحالة: متصل (صامت)';
        }, 200);
    } catch(e) {}
}

async function leaveRoom() {
    const prev = currentRoom;
    currentRoom = null;
    localStorage.removeItem('active_room');
    if (window._presenceInterval) { clearInterval(window._presenceInterval); window._presenceInterval = null; }
    cleanupRoomResources(true);
    updateRoomUI(false);
    showToast(prev ? 'تمت مغادرة الغرفة' : 'تم الخروج', 'success');
}

function cleanupRoomResources(destroyPeer = true) {
    if (roomSubscription) { try { roomSubscription.close(); } catch(e) {} roomSubscription = null; }
    announcedPeers.clear();
    activeCalls.forEach(call => { try { call.close(); } catch(e) {} });
    activeCalls.clear();
    document.querySelectorAll('#audio-container audio, body > audio[id^="audio-"]').forEach(a => { try { a.pause(); } catch(e) {} a.srcObject = null; a.remove(); });
    if (localStream) { localStream.getTracks().forEach(t => t.stop()); localStream = null; }
    if (destroyPeer && peer) { try { peer.destroy(); } catch(e) {} peer = null; myPeerId = null; }
    if (bgAudioContext) { try { bgAudioContext.close(); } catch(e) {} bgAudioContext = null; }
    if (silentAudioElement) { try { silentAudioElement.pause(); } catch(e) {} silentAudioElement.remove(); silentAudioElement = null; }
    if (wakeLock) { try { wakeLock.release(); } catch(e) {} wakeLock = null; }
    isMuted = false;
    const list = $('peers-list');
    if (list) list.innerHTML = '';
    const muteBtn = $('btn-mute');
    if (muteBtn) { muteBtn.innerHTML = '<i class="fas fa-microphone"></i>'; muteBtn.classList.remove('bg-red-100', 'text-red-500'); }
}

async function restoreRoomAfterRefresh() {
    const saved = localStorage.getItem('active_room');
    if (!saved) return;
    const input = $('room-input');
    if (input) input.value = saved;
    currentRoom = null;
    await sleep(800);
    try { await joinRoom(safeRoomName(saved)); } catch(e) { showToast('كانت لديك غرفة مفتوحة. اضغط "دخول" لإعادة الاتصال.', 'info'); }
}

// ============================
// 17. اكتشاف الغرف الحية (Room Directory)
// ============================

function startRoomDirectory() {
    if (directorySubscription) return;
    try {
        directorySubscription = pool.subscribeMany(RELAYS, [{ kinds: [ROOM_EVENT_KIND], '#t': [DISCOVERY_TAG], limit: 300 }], {
            onevent: event => handleDirectoryPresence(event),
            oneose: () => renderRoomDirectory(),
            onclose: () => {}
        });
    } catch(e) { console.warn('[Room Directory] فشل:', e); }
    if (!directoryCleanupInterval) {
        directoryCleanupInterval = setInterval(() => { pruneRoomDirectory(); renderRoomDirectory(); }, 15000);
    }
}

function handleDirectoryPresence(event) {
    if (!event?.content) return;
    let data;
    try { data = JSON.parse(event.content); } catch(e) { return; }
    const roomTag = event.tags.find(t => t[0] === 'room')?.[1];
    const roomName = safeRoomName(roomTag || data.room || '');
    if (!roomName || !data.peerId) return;
    if (!discoveredRooms.has(roomName)) discoveredRooms.set(roomName, new Map());
    discoveredRooms.get(roomName).set(event.pubkey, { peerId: data.peerId, lastSeen: Date.now() });
    if (discoveredRooms.size > MAX_DISCOVERED_ROOMS) {
        const oldest = Array.from(discoveredRooms.keys()).slice(0, discoveredRooms.size - MAX_DISCOVERED_ROOMS);
        oldest.forEach(key => discoveredRooms.delete(key));
    }
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
    if (rooms.length === 0) {
        container.innerHTML = '';
        if (emptyState) emptyState.classList.remove('hidden');
        return;
    }
    if (emptyState) emptyState.classList.add('hidden');
    container.innerHTML = rooms.map(room => `
        <button onclick="joinDiscoveredRoom('${room.name.replace(/'/g, "\\'")}')"
                class="w-full flex items-center justify-between gap-3 bg-gray-50 dark:bg-gray-800/50 hover:bg-gray-100 dark:hover:bg-gray-700 transition rounded-xl px-4 py-3 text-right">
            <span class="flex items-center gap-2 text-sm font-bold text-gray-800 dark:text-gray-100">
                <i class="fas fa-circle text-[8px] text-green-500 animate-pulse"></i> ${escapeHtml(room.name)}
            </span>
            <span class="text-xs text-gray-400 shrink-0"><i class="fas fa-user-friends ml-1"></i>${room.count}</span>
        </button>
    `).join('');
}

function joinDiscoveredRoom(roomName) {
    if (currentRoom) return;
    const input = $('room-input');
    if (input) input.value = roomName;
    joinRoom(safeRoomName(roomName));
}

// ============================
// 18. التنقل والمظهر
// ============================

function switchView(viewName) {
    document.querySelectorAll('.view-section').forEach(s => s.classList.add('hidden'));
    const target = $(`view-${viewName}`);
    if (target) target.classList.remove('hidden');
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
    const panel = $('settings-panel');
    if (panel) panel.classList.toggle('hidden');
}

// ============================
// 19. تحميل المزيد
// ============================

function updateLoadMoreButton() {
    const container = $('load-more-container');
    if (!container) return;
    if (renderedPosts.size >= MAX_RENDERED_POSTS) {
        container.classList.remove('hidden');
    } else {
        container.classList.add('hidden');
    }
}

async function loadMorePosts() {
    if (loadingMore) return;
    const container = $('load-more-container');
    if (!container) return;
    const spinner = $('loading-more-spinner');
    if (spinner) spinner.classList.remove('hidden');

    loadingMore = true;
    try {
        const cards = document.querySelectorAll('.post-card');
        if (!cards.length) { loadingMore = false; if (spinner) spinner.classList.add('hidden'); return; }
        let oldest = Infinity;
        for (const card of cards) {
            const id = card.dataset.postId;
            const data = postContentMap.get(id);
            if (data?.created_at && data.created_at < oldest) oldest = data.created_at;
        }
        if (oldest === Infinity) { loadingMore = false; if (spinner) spinner.classList.add('hidden'); return; }

        const sub = pool.subscribeMany(RELAYS, [{ kinds: [1], '#t': [APP_TAG], until: oldest, limit: 100 }], {
            onevent: event => {
                if (!event?.id) return;
                if (event.kind === 5) { handleDeleteEvent(event); return; }
                if (isReplyEvent(event)) {
                    handleIncomingReply(event);
                    return;
                }
                if (seenEvents.has(event.id)) return;
                seenEvents.add(event.id);
                initPostState(event.id, event.created_at);
                updatePostScore(event.id);
                postContentMap.set(event.id, { content: event.content, created_at: event.created_at });
                renderPost(event);
                reorderFeed();
                scheduleReactionResubscribe();
            },
            oneose: () => {
                loadingMore = false;
                if (spinner) spinner.classList.add('hidden');
                updateLoadMoreButton();
                processAllPendingReplies();
            },
            onclose: () => { loadingMore = false; if (spinner) spinner.classList.add('hidden'); }
        });
    } catch (e) {
        loadingMore = false;
        if (spinner) spinner.classList.add('hidden');
        showToast('فشل تحميل المزيد: ' + getErrorMessage(e), 'error');
    }
}

// ============================
// 20. دوال الصور المفقودة
// ============================

function onAvatarSelected(event) {
    const file = event.target.files?.[0];
    if (!file) return;
    const error = validateImageFile(file);
    if (error) { showToast(error, 'error'); return; }
    revokePreview(pendingAvatarPreviewUrl);
    pendingAvatarFile = file;
    pendingAvatarPreviewUrl = URL.createObjectURL(file);
    renderProfileImages();
}

function onBannerSelected(event) {
    const file = event.target.files?.[0];
    if (!file) return;
    const error = validateImageFile(file);
    if (error) { showToast(error, 'error'); return; }
    revokePreview(pendingBannerPreviewUrl);
    pendingBannerFile = file;
    pendingBannerPreviewUrl = URL.createObjectURL(file);
    renderProfileImages();
}

function removeBanner() {
    revokePreview(pendingBannerPreviewUrl);
    pendingBannerPreviewUrl = null;
    pendingBannerFile = null;
    renderProfileImages();
}

// ============================
// 21. Boot
// ============================

document.addEventListener('DOMContentLoaded', async () => {
    console.log('[Pulse] بدء التشغيل');
    if (localStorage.getItem('theme') === 'dark' || (!localStorage.getItem('theme') && window.matchMedia('(prefers-color-scheme: dark)').matches)) {
        document.documentElement.classList.add('dark');
    }
    await initIdentity();
    loadMyProfile();
    startFeed();
    startRoomDirectory();
    const savedView = localStorage.getItem('pulse_view') || 'timeline';
    switchView(savedView);
    const savedRoom = localStorage.getItem('active_room');
    if (savedRoom) {
        switchView('rooms');
        setTimeout(restoreRoomAfterRefresh, 1200);
    }
});

if ('serviceWorker' in navigator) {
    window.addEventListener('load', () => {
        navigator.serviceWorker.register('./sw.js')
            .then(() => console.log('[SW] Registered'))
            .catch(e => console.warn('[SW] Failed:', e));
    });
}

// ربط الدوال للنطاق العام
window.publishPost = publishPost;
window.likePost = likePost;
window.replyToPost = replyToPost;
window.replyToComment = replyToComment;
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
window.onAvatarSelected = onAvatarSelected;
window.onBannerSelected = onBannerSelected;
window.removeBanner = removeBanner;
window.onProfileNameInput = onProfileNameInput;
window.onProfileAboutInput = onProfileAboutInput;
window.showToast = showToast;
window.deletePost = deletePost;
window.editPost = editPost;
window.closeEditModal = closeEditModal;
window.confirmEdit = confirmEdit;
window.triggerFileUpload = triggerFileUpload;
window.handleFileSelect = handleFileSelect;
window.removeAttachment = removeAttachment;
window.toggleReplies = toggleReplies;
window.triggerEditFileUpload = triggerEditFileUpload;
window.handleEditFileSelect = handleEditFileSelect;
window.removeEditAttachment = removeEditAttachment;
window.loadMorePosts = loadMorePosts;
