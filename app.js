/* =========================================================
   Pulse - التطبيق الرئيسي (نسخة محسّنة)
   نظام Nostr + المنشورات + غرف الصوت WebRTC
   خوارزمية ترتيب ديناميكي + حذف وتعديل + إعجاب/إلغاء إعجاب + وسائط
   ========================================================= */

const RELAYS = [
    'wss://relay.damus.io',
    'wss://relay.primal.net',
    'wss://nos.lol',
    'wss://relay.nostr.band'
];

const APP_TAG = 'pulse-platform';
const ROOM_EVENT_KIND = 20000;
const MAX_SEEN_EVENTS = 5000;
const MAX_RENDERED_POSTS = 150;
const MAX_DISCOVERED_ROOMS = 50;

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
const renderedPosts = new Map();      // postId -> HTMLElement
const postScores = new Map();         // postId -> number (score)
const profileCache = new Map();
const postStats = new Map();          // postId -> { likes, replies, createdAt, myLikeEventId? }
const postContentMap = new Map();     // postId -> { content, created_at }

let postsSubscription = null;
let reactionsSubscription = null;

// اكتشاف الغرف
const discoveredRooms = new Map();    // roomName -> Map(pubkey -> { peerId, lastSeen })
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
        postScores.clear();
        postStats.clear();
        postContentMap.clear();
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
   Profile editor
   ========================================================= */

let myProfile = {
    name: '',
    picture: '',
    banner: '',
    about: '',
    location: '',
    website: ''
};

let pendingAvatarFile = null;
let pendingBannerFile = null;
let pendingAvatarPreviewUrl = null;
let pendingBannerPreviewUrl = null;

const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
const ALLOWED_IMAGE_TYPES = ['image/jpeg', 'image/png', 'image/webp', 'image/gif'];

function revokePreview(url) {
    if (url && String(url).startsWith('blob:')) {
        try { URL.revokeObjectURL(url); } catch (e) {}
    }
}

function validateImageFile(file) {
    if (!file) return 'لم يتم اختيار ملف';
    if (!ALLOWED_IMAGE_TYPES.includes(file.type)) {
        return 'صيغة غير مدعومة. استخدم JPG أو PNG أو WebP أو GIF';
    }
    if (file.size > MAX_IMAGE_BYTES) {
        return 'حجم الصورة كبير (الحد الأقصى 5MB)';
    }
    return null;
}

async function compressImage(file, maxWidth, quality) {
    return new Promise((resolve, reject) => {
        const img = new Image();
        const objectUrl = URL.createObjectURL(file);
        img.onload = () => {
            try {
                const scale = Math.min(1, maxWidth / img.width);
                const w = Math.max(1, Math.round(img.width * scale));
                const h = Math.max(1, Math.round(img.height * scale));
                const canvas = document.createElement('canvas');
                canvas.width = w;
                canvas.height = h;
                const ctx = canvas.getContext('2d');
                ctx.drawImage(img, 0, 0, w, h);
                canvas.toBlob(
                    blob => {
                        URL.revokeObjectURL(objectUrl);
                        if (!blob) {
                            reject(new Error('فشل ضغط الصورة'));
                            return;
                        }
                        resolve(new File([blob], file.name.replace(/\.\w+$/, '.jpg'), { type: 'image/jpeg' }));
                    },
                    'image/jpeg',
                    quality
                );
            } catch (e) {
                URL.revokeObjectURL(objectUrl);
                reject(e);
            }
        };
        img.onerror = () => {
            URL.revokeObjectURL(objectUrl);
            reject(new Error('تعذر قراءة الصورة'));
        };
        img.src = objectUrl;
    });
}

async function buildNip98AuthHeader(url, method) {
    const eventTemplate = {
        kind: 27235,
        created_at: Math.floor(Date.now() / 1000),
        tags: [
            ['u', url],
            ['method', method]
        ],
        content: ''
    };
    const signedEvent = await signEvent(eventTemplate);
    const json = JSON.stringify(signedEvent);
    const base64 = btoa(unescape(encodeURIComponent(json)));
    return `Nostr ${base64}`;
}

async function uploadFileToNostrBuild(file) {
    const uploadUrl = 'https://nostr.build/api/v2/upload/files';
    const form = new FormData();
    form.append('file[]', file);

    let authHeader = null;
    try {
        authHeader = await buildNip98AuthHeader(uploadUrl, 'POST');
    } catch (authError) {
        console.warn('[Upload] تعذر توليد ترويسة NIP-98، سيتم المحاولة بدونها:', authError);
    }

    const res = await fetch(uploadUrl, {
        method: 'POST',
        headers: authHeader ? { Authorization: authHeader } : undefined,
        body: form
    });

    if (!res.ok) {
        if (res.status === 401) {
            throw new Error('رفض السيرفر رفع الملف (401) — تأكد من هويتك وحاول تاني');
        }
        throw new Error('فشل رفع الملف (' + res.status + ')');
    }

    const data = await res.json();
    const item = Array.isArray(data) ? data[0] : (data?.data?.[0] || data?.[0] || data);
    const url =
        item?.url ||
        item?.nip94_event?.tags?.find(t => t[0] === 'url')?.[1] ||
        item?.data?.url ||
        null;

    if (!url || typeof url !== 'string') {
        throw new Error('لم يُرجع سيرفر الصور رابطًا صالحًا');
    }
    return url;
}

async function uploadFiles(files) {
    const urls = [];
    for (const file of files) {
        try {
            const url = await uploadFileToNostrBuild(file);
            urls.push({ url, type: file.type });
        } catch (e) {
            console.warn('[Upload] فشل رفع ملف:', e);
            showToast('فشل رفع أحد الملفات', 'error');
        }
    }
    return urls;
}

function setUploadStatus(text, isError) {
    const el = $('profile-upload-status');
    if (!el) return;
    if (!text) {
        el.classList.add('hidden');
        el.textContent = '';
        return;
    }
    el.classList.remove('hidden');
    el.textContent = text;
    el.className = 'text-xs text-center ' + (isError ? 'text-red-500' : 'text-gray-400');
}

function onProfileNameInput() {
    const val = ($('profile-name')?.value || '');
    const counter = $('name-count');
    if (counter) counter.textContent = String(val.length);
    const letter = $('profile-avatar-letter');
    if (letter && !myProfile.picture && !pendingAvatarPreviewUrl) {
        letter.textContent = (val.trim() || 'P').slice(0, 1).toUpperCase();
    }
}

function onProfileAboutInput() {
    const val = ($('profile-about')?.value || '');
    const counter = $('about-count');
    if (counter) counter.textContent = String(val.length);
}

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
            if (removeBannerBtn) {
                removeBannerBtn.classList.remove('hidden');
                removeBannerBtn.classList.add('flex');
            }
        } else {
            bannerImg.classList.add('hidden');
            bannerEmpty.classList.remove('hidden');
            if (removeBannerBtn) {
                removeBannerBtn.classList.add('hidden');
                removeBannerBtn.classList.remove('flex');
            }
        }
    }
}

function onAvatarSelected(event) {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file) return;

    const err = validateImageFile(file);
    if (err) {
        showToast(err, 'error');
        return;
    }

    revokePreview(pendingAvatarPreviewUrl);
    pendingAvatarFile = file;
    pendingAvatarPreviewUrl = URL.createObjectURL(file);
    renderProfileImages();
}

function onBannerSelected(event) {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file) return;

    const err = validateImageFile(file);
    if (err) {
        showToast(err, 'error');
        return;
    }

    revokePreview(pendingBannerPreviewUrl);
    pendingBannerFile = file;
    pendingBannerPreviewUrl = URL.createObjectURL(file);
    renderProfileImages();
}

function removeBanner() {
    pendingBannerFile = null;
    revokePreview(pendingBannerPreviewUrl);
    pendingBannerPreviewUrl = null;
    myProfile.banner = '';
    renderProfileImages();
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

    if ($('profile-name')) $('profile-name').value = myProfile.name || '';
    if ($('profile-about')) $('profile-about').value = myProfile.about || '';
    if ($('profile-location')) $('profile-location').value = myProfile.location || '';
    if ($('profile-website')) $('profile-website').value = myProfile.website || '';

    onProfileNameInput();
    onProfileAboutInput();
    renderProfileImages();
    setUploadStatus('');

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
    if (!pk) {
        showToast('لا توجد هوية جاهزة بعد', 'error');
        return;
    }

    const name = ($('profile-name')?.value || '').trim().slice(0, 50);
    const about = ($('profile-about')?.value || '').trim().slice(0, 160);
    const location = ($('profile-location')?.value || '').trim().slice(0, 30);
    const website = ($('profile-website')?.value || '').trim().slice(0, 100);

    if (!name) {
        showToast('الاسم مطلوب', 'error');
        return;
    }

    if (website && !/^https?:\/\//i.test(website)) {
        showToast('رابط الموقع لازم يبدأ بـ http:// أو https://', 'error');
        return;
    }

    const btn = $('btn-save-profile');
    if (btn) btn.disabled = true;

    try {
        let pictureUrl = myProfile.picture || '';
        let bannerUrl = myProfile.banner || '';

        if (pendingAvatarFile) {
            setUploadStatus('جاري رفع الصورة الشخصية...');
            const compressed = await compressImage(pendingAvatarFile, 400, 0.85);
            pictureUrl = await uploadFileToNostrBuild(compressed);
        }

        if (pendingBannerFile) {
            setUploadStatus('جاري رفع صورة الغلاف...');
            const compressed = await compressImage(pendingBannerFile, 1500, 0.82);
            bannerUrl = await uploadFileToNostrBuild(compressed);
        }

        setUploadStatus('جاري حفظ الملف على Nostr...');

        const contentObj = {
            name,
            display_name: name,
            about: about || undefined,
            picture: pictureUrl || undefined,
            banner: bannerUrl || undefined,
            location: location || undefined,
            website: website || undefined
        };

        Object.keys(contentObj).forEach(k => {
            if (contentObj[k] === undefined || contentObj[k] === '') delete contentObj[k];
        });

        const signedEvent = await signEvent({
            kind: 0,
            created_at: Math.floor(Date.now() / 1000),
            tags: [],
            content: JSON.stringify(contentObj)
        });

        await pool.publish(RELAYS, signedEvent);

        myProfile = { name, about, picture: pictureUrl, banner: bannerUrl, location, website };

        profileCache.set(pk, {
            name,
            picture: pictureUrl || null,
            about: about || null
        });

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
        console.error('[Profile] فشل الحفظ:', error);
        setUploadStatus(getErrorMessage(error), true);
        showToast('فشل الحفظ: ' + getErrorMessage(error), 'error');
    } finally {
        if (btn) btn.disabled = false;
    }
}

function loadMyProfile() {
    if (!pk) return;
    let sub = null;
    try {
        sub = pool.subscribeMany(
            RELAYS,
            [{ kinds: [0], authors: [pk], limit: 1 }],
            {
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
                        profileCache.set(pk, {
                            name: myProfile.name || null,
                            picture: myProfile.picture || null,
                            about: myProfile.about || null
                        });
                        updateHeaderAvatar();
                        updateAvatarsInDom(pk);
                    } catch (e) {}
                },
                oneose: () => {
                    if (sub) try { sub.close(); } catch(e) {}
                }
            }
        );
    } catch (error) {
        console.warn('[Profile] فشل تحميل ملفي الشخصي:', error);
    }
}

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

    if (pubkey === pk) {
        updateHeaderAvatar();
    }
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

let profileFetchQueue = [];
let profileFetchTimer = null;

function fetchProfiles(pubkeys) {
    const needed = pubkeys.filter(p => p && !profileCache.has(p));
    if (!needed.length) return;

    profileFetchQueue.push(...needed);
    if (profileFetchTimer) clearTimeout(profileFetchTimer);

    profileFetchTimer = setTimeout(() => {
        const batch = profileFetchQueue.slice(0, 60);
        profileFetchQueue = [];
        if (!batch.length) return;

        try {
            const sub = pool.subscribeMany(
                RELAYS,
                [{ kinds: [0], authors: batch, limit: 60 }],
                {
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
                    },
                    oneose: () => {
                        if (sub) try { sub.close(); } catch(e) {}
                    }
                }
            );
        } catch (error) {
            console.warn('[Profile] فشل جلب الملفات الشخصية:', error);
        }
    }, 300);
}

/* =========================================================
   خوارزمية التوزين (Edge-like)
   ========================================================= */

function calculateScore(postId) {
    const stats = postStats.get(postId);
    if (!stats) return 0;

    const { likes, replies, createdAt } = stats;
    const now = Date.now() / 1000;
    const hours = Math.max(0.01, (now - createdAt) / 3600);

    const interaction = likes * 1.5 + replies * 2.5;
    const decay = Math.pow(hours + 2, 1.8);
    return interaction / decay;
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
        const idA = a.dataset.postId;
        const idB = b.dataset.postId;
        const scoreA = postScores.get(idA) || 0;
        const scoreB = postScores.get(idB) || 0;
        return scoreB - scoreA;
    });

    const fragment = document.createDocumentFragment();
    cards.forEach(card => fragment.appendChild(card));
    container.appendChild(fragment);
}

/* =========================================================
   دالة عرض الوسائط المحسّنة باستخدام DOMPurify (التصحيح الجذري)
   ========================================================= */

function renderMediaContent(content) {
    if (!content) return '';

    // 1. استبدال الروابط بوسوم HTML مباشرة (بدون escapeHtml)
    let html = content;

    // 1.1 صور
    html = html.replace(
        /(https?:\/\/[^\s<>"']+\.(jpe?g|png|gif|webp|svg|bmp|ico)(\?[^\s<>"']*)?)/gi,
        (match) => {
            const safeUrl = match.replace(/&/g, '&amp;'); // ترميز آمن للـ URL
            return `<img src="${safeUrl}" alt="صورة" class="max-w-full rounded-xl my-2 max-h-[500px] object-contain border border-gray-200 dark:border-gray-700 shadow-sm cursor-pointer" loading="lazy" onclick="window.open('${safeUrl}', '_blank')" onerror="this.style.display='none'" />`;
        }
    );

    // 1.2 فيديو
    html = html.replace(
        /(https?:\/\/[^\s<>"']+\.(mp4|webm|mov|avi|mkv|ogg)(\?[^\s<>"']*)?)/gi,
        (match) => {
            const safeUrl = match.replace(/&/g, '&amp;');
            return `<video src="${safeUrl}" controls class="max-w-full rounded-xl my-2 max-h-[500px] w-full border border-gray-200 dark:border-gray-700 shadow-sm" preload="metadata" playsinline></video>`;
        }
    );

    // 1.3 YouTube
    html = html.replace(
        /(?:https?:\/\/)?(?:www\.)?(?:youtube\.com\/watch\?v=|youtu\.be\/)([a-zA-Z0-9_-]{11})/gi,
        (match, videoId) => {
            return `<iframe class="w-full rounded-xl my-2 aspect-video border border-gray-200 dark:border-gray-700 shadow-sm" src="https://www.youtube.com/embed/${videoId}" frameborder="0" allowfullscreen loading="lazy"></iframe>`;
        }
    );

    // 1.4 Vimeo
    html = html.replace(
        /(?:https?:\/\/)?(?:www\.)?vimeo\.com\/(\d+)/gi,
        (match, videoId) => {
            return `<iframe class="w-full rounded-xl my-2 aspect-video border border-gray-200 dark:border-gray-700 shadow-sm" src="https://player.vimeo.com/video/${videoId}" frameborder="0" allowfullscreen loading="lazy"></iframe>`;
        }
    );

    // 1.5 الروابط العامة (التي لم تتحول إلى وسوم)
    // نستثني الروابط الموجودة داخل وسوم img أو video أو iframe
    html = html.replace(
        /(https?:\/\/[^\s<>"']+)(?![^<]*<\/?(?:img|video|iframe)>)/gi,
        (match) => {
            return `<a href="${match}" target="_blank" rel="noopener noreferrer" class="text-accent hover:underline">${match}</a>`;
        }
    );

    // 2. تنظيف الناتج باستخدام DOMPurify (حماية من XSS مع الحفاظ على الوسوم)
    if (typeof DOMPurify !== 'undefined') {
        html = DOMPurify.sanitize(html, {
            ALLOWED_TAGS: ['img', 'video', 'iframe', 'a', 'p', 'br', 'strong', 'b', 'em', 'i', 'u', 's', 'ul', 'ol', 'li', 'blockquote', 'code', 'pre', 'span', 'div'],
            ALLOWED_ATTR: ['src', 'alt', 'class', 'onclick', 'controls', 'preload', 'playsinline', 'href', 'target', 'rel', 'frameborder', 'allowfullscreen', 'loading', 'width', 'height', 'style']
        });
    }

    return html;
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
            [{ kinds: [1, 5], limit: 150 }],
            {
                onevent: event => {
                    if (!event || !event.id) return;

                    if (event.kind === 5) {
                        handleDeleteEvent(event);
                        return;
                    }

                    const hasTag = event.tags && event.tags.some(t => t[0] === 't' && t[1] === APP_TAG);
                    if (!hasTag) return;

                    if (isReplyEvent(event)) {
                        handleIncomingReply(event);
                        return;
                    }

                    if (seenEvents.has(event.id)) return;
                    seenEvents.add(event.id);
                    limitSet(seenEvents, MAX_SEEN_EVENTS);

                    postStats.set(event.id, {
                        likes: 0,
                        replies: 0,
                        createdAt: event.created_at,
                        myLikeEventId: null
                    });
                    updatePostScore(event.id);

                    postContentMap.set(event.id, {
                        content: event.content,
                        created_at: event.created_at
                    });

                    renderPost(event);
                    reorderFeed();
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
    const isOwner = (event.pubkey === pk);

    // استخدام دالة renderMediaContent لعرض الوسائط
    const contentHtml = renderMediaContent(event.content);

    const div = document.createElement('div');
    div.className =
        'post-card bg-white dark:bg-cardDark rounded-3xl p-5 shadow-soft border border-gray-100 dark:border-gray-800 fade-in transition-all duration-200';
    div.dataset.postId = event.id;
    div.dataset.author = event.pubkey;

    div.innerHTML = `
        <div class="flex justify-between items-start mb-4">
            <div class="flex items-center gap-3 min-w-0">
                <div class="avatar-slot flex-shrink-0">
                    ${avatarHtml(event.pubkey, 'w-11 h-11 text-base')}
                </div>
                <div class="min-w-0 flex-1">
                    <div class="author-name font-bold text-sm dark:text-white truncate">
                        ${escapeHtml(displayName)}
                    </div>
                    <div class="text-xs text-gray-400">
                        ${escapeHtml(time)}
                    </div>
                </div>
            </div>
            ${isOwner ? `
            <div class="flex gap-1 flex-shrink-0">
                <button onclick="editPost('${event.id}')" 
                        class="text-xs text-blue-500 hover:text-blue-700 transition p-1.5 rounded-lg hover:bg-blue-50 dark:hover:bg-blue-500/10" 
                        title="تعديل المنشور">
                    <i class="fas fa-edit"></i>
                </button>
                <button onclick="deletePost('${event.id}')" 
                        class="text-xs text-red-500 hover:text-red-700 transition p-1.5 rounded-lg hover:bg-red-50 dark:hover:bg-red-500/10" 
                        title="حذف المنشور">
                    <i class="fas fa-trash"></i>
                </button>
            </div>
            ` : ''}
        </div>

        <div class="post-content text-gray-800 dark:text-gray-200 leading-relaxed mb-4 whitespace-pre-wrap text-sm md:text-base break-words">
            ${contentHtml}
        </div>

        <div class="flex items-center gap-5 text-gray-400 text-sm border-t border-gray-100 dark:border-gray-800 pt-3">
            <button
                class="like-button flex items-center gap-2 hover:text-red-500 transition"
                onclick="likePost('${event.id}', '${event.pubkey}')"
                data-liked="false"
                data-postid="${event.id}"
            >
                <i class="far fa-heart"></i>
                <span>إعجاب</span>
                <span class="like-count" data-count="0">0</span>
            </button>

            <button
                class="reply-button flex items-center gap-2 hover:text-accent transition"
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
    container.appendChild(div);

    fetchProfiles([event.pubkey]);
}

/* =========================================================
   حذف المنشور (kind 5)
   ========================================================= */

async function deletePost(postId) {
    if (!pk) {
        showToast('لا توجد هوية', 'error');
        return;
    }

    if (!confirm('هل أنت متأكد من حذف هذا المنشور؟')) return;

    try {
        const eventTemplate = {
            kind: 5,
            created_at: Math.floor(Date.now() / 1000),
            tags: [
                ['e', postId]
            ],
            content: ''
        };

        const signedEvent = await signEvent(eventTemplate);
        await pool.publish(RELAYS, signedEvent);

        removePostFromUI(postId);
        showToast('تم حذف المنشور', 'success');
    } catch (error) {
        console.error('[Delete] فشل:', error);
        showToast('فشل الحذف: ' + getErrorMessage(error), 'error');
    }
}

function handleDeleteEvent(event) {
    const targetId = getTagValue(event.tags, 'e');
    if (!targetId) return;

    // التحقق إذا كان الهدف منشوراً
    if (renderedPosts.has(targetId)) {
        const card = getPostCard(targetId);
        if (card && card.dataset.author === event.pubkey) {
            removePostFromUI(targetId);
        }
        return;
    }

    // التحقق إذا كان الهدف إعجاباً (لإلغاء الإعجاب)
    for (const [postId, stats] of postStats) {
        if (stats.myLikeEventId === targetId) {
            stats.likes = Math.max(0, stats.likes - 1);
            stats.myLikeEventId = null;
            updatePostScore(postId);
            
            const card = getPostCard(postId);
            if (card) {
                const likeBtn = card.querySelector('.like-button');
                if (likeBtn) {
                    likeBtn.dataset.liked = 'false';
                    const icon = likeBtn.querySelector('i');
                    if (icon) icon.className = 'far fa-heart';
                    likeBtn.classList.remove('text-red-500', 'font-bold');
                }
                const countEl = card.querySelector('.like-count');
                if (countEl) {
                    countEl.dataset.count = String(stats.likes);
                    countEl.textContent = String(stats.likes);
                }
            }
            reorderFeed();
            break;
        }
    }
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
    }
}

/* =========================================================
   تعديل المنشور
   ========================================================= */

let editingPostId = null;

function editPost(postId) {
    const data = postContentMap.get(postId);
    if (!data) {
        showToast('تعذر العثور على محتوى المنشور', 'error');
        return;
    }

    const modal = $('edit-modal');
    const textarea = $('edit-input');
    if (!modal || !textarea) {
        showToast('مودال التعديل غير جاهز', 'error');
        return;
    }

    editingPostId = postId;
    textarea.value = data.content;
    modal.classList.remove('hidden');
    setTimeout(() => textarea.focus(), 50);
}

function closeEditModal() {
    const modal = $('edit-modal');
    if (modal) modal.classList.add('hidden');
    editingPostId = null;
}

async function confirmEdit() {
    if (!editingPostId) return;
    const textarea = $('edit-input');
    const newContent = (textarea?.value || '').trim();
    if (!newContent) {
        showToast('المحتوى لا يمكن أن يكون فارغاً', 'error');
        return;
    }

    const oldPostId = editingPostId;
    const originalData = postContentMap.get(oldPostId);
    if (!originalData) {
        showToast('المنشور الأصلي غير موجود', 'error');
        return;
    }

    try {
        // 1. حذف المنشور القديم
        const deleteEvent = {
            kind: 5,
            created_at: Math.floor(Date.now() / 1000),
            tags: [['e', oldPostId]],
            content: ''
        };
        const signedDelete = await signEvent(deleteEvent);
        await pool.publish(RELAYS, signedDelete);

        // 2. نشر منشور جديد
        const newEventTemplate = {
            kind: 1,
            created_at: Math.floor(Date.now() / 1000),
            tags: [['t', APP_TAG]],
            content: newContent
        };
        const signedNew = await signEvent(newEventTemplate);
        await pool.publish(RELAYS, signedNew);

        // 3. تحديث الواجهة
        const oldCard = getPostCard(oldPostId);
        if (oldCard) {
            oldCard.remove();
            renderedPosts.delete(oldPostId);
            postStats.delete(oldPostId);
            postScores.delete(oldPostId);
            postContentMap.delete(oldPostId);
            seenEvents.delete(oldPostId);

            postStats.set(signedNew.id, {
                likes: 0,
                replies: 0,
                createdAt: signedNew.created_at,
                myLikeEventId: null
            });
            updatePostScore(signedNew.id);
            postContentMap.set(signedNew.id, {
                content: signedNew.content,
                created_at: signedNew.created_at
            });
            renderPost(signedNew);
            reorderFeed();
            showToast('تم تعديل المنشور ✅', 'success');
        } else {
            seenEvents.add(signedNew.id);
            postStats.set(signedNew.id, {
                likes: 0,
                replies: 0,
                createdAt: signedNew.created_at,
                myLikeEventId: null
            });
            updatePostScore(signedNew.id);
            postContentMap.set(signedNew.id, {
                content: signedNew.content,
                created_at: signedNew.created_at
            });
            renderPost(signedNew);
            reorderFeed();
            showToast('تم التعديل ونشر نسخة جديدة', 'success');
        }

        closeEditModal();
    } catch (error) {
        console.error('[Edit] فشل:', error);
        showToast('فشل التعديل: ' + getErrorMessage(error), 'error');
    }
}

/* =========================================================
   نشر منشور مع دعم رفع الملفات
   ========================================================= */

function triggerFileUpload() {
    document.getElementById('file-input')?.click();
}

async function handleFileSelect(event) {
    const files = event.target.files;
    if (!files || files.length === 0) return;

    showToast('جاري رفع الملفات...', 'info');
    const uploaded = await uploadFiles(Array.from(files));
    if (uploaded.length === 0) {
        showToast('فشل رفع الملفات', 'error');
        return;
    }

    const input = $('post-input');
    if (input) {
        let text = input.value;
        uploaded.forEach(item => {
            text += `\n${item.url}`;
        });
        input.value = text.trim();
    }
    event.target.value = '';
    showToast(`تم رفع ${uploaded.length} ملف(ات)`, 'success');
}

async function publishPost() {
    const input = $('post-input');
    if (!input) {
        showToast('حقل الكتابة غير موجود', 'error');
        return;
    }

    let content = (input.value || '').trim();
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
            postStats.set(signedEvent.id, {
                likes: 0,
                replies: 0,
                createdAt: signedEvent.created_at,
                myLikeEventId: null
            });
            postContentMap.set(signedEvent.id, {
                content: signedEvent.content,
                created_at: signedEvent.created_at
            });
            updatePostScore(signedEvent.id);
            renderPost(signedEvent);
            reorderFeed();
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
   الإعجابات والردود مع إلغاء الإعجاب
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

    const postStat = postStats.get(targetId);
    if (!postStat) return;

    // إلغاء الإعجاب
    if (stats.likeButton.dataset.liked === 'true') {
        if (postStat.myLikeEventId) {
            try {
                const deleteEvent = {
                    kind: 5,
                    created_at: Math.floor(Date.now() / 1000),
                    tags: [['e', postStat.myLikeEventId]],
                    content: ''
                };
                const signedDelete = await signEvent(deleteEvent);
                await pool.publish(RELAYS, signedDelete);

                postStat.likes = Math.max(0, postStat.likes - 1);
                postStat.myLikeEventId = null;
                updatePostScore(targetId);
                updateLikeUI(targetId, false, -1);
                reorderFeed();
                showToast('تم إلغاء الإعجاب', 'info');
            } catch (error) {
                console.error('[Unlike] فشل:', error);
                showToast('فشل إلغاء الإعجاب: ' + getErrorMessage(error), 'error');
            }
        }
        return;
    }

    // إعجاب جديد
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

        postStat.likes += 1;
        postStat.myLikeEventId = signedEvent.id;
        updatePostScore(targetId);
        updateLikeUI(targetId, true, 1);
        stats.likeButton.classList.add('scale-110');
        setTimeout(() => stats.likeButton.classList.remove('scale-110'), 180);
        reorderFeed();
        showToast('تم الإعجاب ❤️', 'success');
    } catch (error) {
        console.error('[Like] فشل:', error);
        showToast('فشل الإعجاب: ' + getErrorMessage(error), 'error');
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
            [{ kinds: [7, 1, 5], '#e': postIds, limit: 500 }],
            {
                onevent: event => {
                    if (!event || !event.id) return;
                    if (event.kind === 7) handleIncomingLike(event);
                    if (event.kind === 1) handleIncomingReply(event);
                    if (event.kind === 5) handleDeleteEvent(event);
                },
                oneose: () => console.log('[Reactions] تم التحميل')
            }
        );
    } catch (error) {
        console.error('[Reactions] خطأ:', error);
    }
}

function handleIncomingLike(event) {
    if (seenEvents.has(event.id)) return;
    seenEvents.add(event.id);
    limitSet(seenEvents, MAX_SEEN_EVENTS);

    const targetId = getTagValue(event.tags, 'e');
    if (!targetId) return;

    // تجاهل إعجابات المستخدم نفسه (تم التعامل معها محلياً)
    if (event.pubkey === pk) return;

    const stats = getReactionStats(targetId);
    if (!stats) return;

    const postStat = postStats.get(targetId);
    if (!postStat) return;

    // تحديث الإحصائيات
    postStat.likes += 1;
    updatePostScore(targetId);

    // تحديث الواجهة
    const currentCount = Number(stats.likeCount.dataset.count || 0);
    stats.likeCount.dataset.count = String(currentCount + 1);
    stats.likeCount.textContent = String(currentCount + 1);

    reorderFeed();
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

    const postStat = postStats.get(targetId);
    if (postStat) {
        postStat.replies += 1;
        updatePostScore(targetId);
    }

    const replyCount = Number(stats.replyCount.dataset.count || 0);
    stats.replyCount.dataset.count = String(replyCount + 1);
    stats.replyCount.textContent = String(replyCount + 1);

    const repliesContainer = stats.card.querySelector(`[data-replies="${CSS.escape(targetId)}"]`);
    if (!repliesContainer) return;

    const reply = document.createElement('div');
    reply.dataset.replyId = event.id;
    reply.className = 'bg-gray-50 dark:bg-gray-800/50 rounded-xl p-3 text-sm border-r-2 border-accent/30 mr-2';
    reply.innerHTML = `
        <div class="flex items-center gap-2 mb-1">
            <div class="avatar-slot">${avatarHtml(event.pubkey, 'w-6 h-6 text-xs')}</div>
            <span class="text-xs font-bold text-gray-700 dark:text-gray-300">${escapeHtml(getDisplayName(event.pubkey))}</span>
        </div>
        <div class="text-gray-700 dark:text-gray-200 mr-2">${escapeHtml(event.content)}</div>
        <button onclick="replyToComment('${event.id}', '${targetId}', '${event.pubkey}')" 
                class="text-xs text-accent hover:underline mt-1 mr-2">
            <i class="fas fa-reply"></i> رد
        </button>
    `;
    repliesContainer.appendChild(reply);
    fetchProfiles([event.pubkey]);

    reorderFeed();
}

/* =========================================================
   الرد على التعليقات (ردود متداخلة)
   ========================================================= */

async function replyToComment(replyToId, rootPostId, targetPubkey) {
    const modal = $('reply-modal');
    const textarea = $('reply-input');
    
    if (modal && textarea) {
        pendingReply = { 
            targetId: replyToId,
            rootId: rootPostId,
            targetPubkey: targetPubkey,
            isCommentReply: true
        };
        textarea.value = '';
        modal.classList.remove('hidden');
        setTimeout(() => textarea.focus(), 50);
        return;
    }

    const content = prompt('اكتب ردك على هذا التعليق:');
    if (!content || !content.trim()) return;
    await sendReplyWithRoot(replyToId, targetPubkey, content.trim(), rootPostId);
}

async function confirmReply() {
    if (!pendingReply) return;
    const textarea = $('reply-input');
    const content = (textarea?.value || '').trim();
    if (!content) {
        showToast('اكتب ردًا', 'error');
        return;
    }
    
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
        const eventTemplate = {
            kind: 1,
            created_at: Math.floor(Date.now() / 1000),
            tags: [
                ['e', replyToId, '', 'reply'],
                ['e', rootId, '', 'root'],
                ['p', targetPubkey],
                ['t', APP_TAG]
            ],
            content: content
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

let pendingReply = null;

async function replyToPost(targetId, targetPubkey) {
    const modal = $('reply-modal');
    const textarea = $('reply-input');

    if (modal && textarea) {
        pendingReply = { 
            targetId, 
            targetPubkey,
            rootId: targetId,
            isCommentReply: false
        };
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

/* =========================================================
   غرف الصوت WebRTC (نفسها، بدون تغيير)
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

    const directoryUi = $('live-rooms-section');

    if (joined) {
        if (activeUi) activeUi.classList.remove('hidden');
        if (directoryUi) directoryUi.classList.add('hidden');
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
        if (directoryUi) directoryUi.classList.remove('hidden');
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
            ['t', DISCOVERY_TAG],
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
    div.className = 'flex items-center gap-2 bg-gray-50 dark:bg-gray-800/50 p-2 rounded-lg';

    const safeName = String(displayName || peerId).slice(0, 16);
    div.innerHTML = `
        <div class="w-2 h-2 bg-green-500 rounded-full animate-pulse"></div>
        <span class="text-sm">${escapeHtml(safeName)}</span>
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

/* =========================================================
   اكتشاف الغرف الحية (Room Directory)
   ========================================================= */

function startRoomDirectory() {
    if (directorySubscription) return;

    try {
        directorySubscription = pool.subscribeMany(
            RELAYS,
            [{ kinds: [ROOM_EVENT_KIND], '#t': [DISCOVERY_TAG], limit: 300 }],
            {
                onevent: event => handleDirectoryPresence(event),
                oneose: () => renderRoomDirectory(),
                onclose: () => {}
            }
        );
    } catch (error) {
        console.warn('[Room Directory] فشل الاشتراك:', error);
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
    try {
        data = JSON.parse(event.content);
    } catch (e) {
        return;
    }

    const roomTagValue = event.tags.find(t => t[0] === 'room')?.[1];
    const roomName = safeRoomName(roomTagValue || data.room || '');
    if (!roomName || !data.peerId) return;

    if (!discoveredRooms.has(roomName)) {
        discoveredRooms.set(roomName, new Map());
    }

    discoveredRooms.get(roomName).set(event.pubkey, {
        peerId: data.peerId,
        lastSeen: Date.now()
    });

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
            if (now - info.lastSeen > ROOM_PRESENCE_TTL_MS) {
                members.delete(pubkey);
            }
        });
        if (members.size === 0) {
            discoveredRooms.delete(roomName);
        }
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
        <button
            onclick="joinDiscoveredRoom('${room.name.replace(/'/g, "\\'")}')"
            class="w-full flex items-center justify-between gap-3 bg-gray-50 dark:bg-gray-800/50 hover:bg-gray-100 dark:hover:bg-gray-700 transition rounded-xl px-4 py-3 text-right"
        >
            <span class="flex items-center gap-2 text-sm font-bold text-gray-800 dark:text-gray-100">
                <i class="fas fa-circle text-[8px] text-green-500 animate-pulse"></i>
                ${escapeHtml(room.name)}
            </span>
            <span class="text-xs text-gray-400 shrink-0">
                <i class="fas fa-user-friends ml-1"></i>${room.count}
            </span>
        </button>
    `).join('');
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
    loadMyProfile();
    startFeed();
    startRoomDirectory();

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
