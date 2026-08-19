/* =========================================================
   Pulse - التطبيق الرئيسي (نسخة محسّنة بالكامل)
   نظام Nostr + المنشورات + غرف الصوت WebRTC
   مع صلاحيات مشرف (حذف محلي لأي منشور أو مستخدم)
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

// ... (نفس الكود السابق حتى دالة copyNpub) ...

// ============================
// 7. الملف الشخصي (Profile)
// ============================

// ... (نفس الكود السابق حتى دالة fetchProfiles) ...

// ============================
// 8. خوارزمية التوزين (Edge-like)
// ============================

// ... (نفس الكود السابق) ...

// ============================
// 9. عرض الوسائط (الصور والفيديو)
// ============================

// ... (نفس الكود السابق) ...

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
    const isAdmin = (pk === adminPubkey);

    // إذا كان المشرف، نعرض زر حذف لكل المنشورات، وإلا فقط للمالك
    const showDelete = isOwner || isAdmin;

    const contentHtml = renderMediaContent(event.content);

    const div = document.createElement('div');
    div.className = 'post-card bg-white dark:bg-cardDark rounded-3xl p-5 shadow-soft border border-gray-100 dark:border-gray-800 fade-in transition-all duration-200';
    div.dataset.postId = event.id;
    div.dataset.author = event.pubkey;

    div.innerHTML = `
        <div class="flex justify-between items-start mb-4">
            <div class="flex items-center gap-3 min-w-0 flex-1">
                <div class="avatar-slot flex-shrink-0">${avatarHtml(event.pubkey, 'w-11 h-11 text-base')}</div>
                <div class="min-w-0 flex-1">
                    <div class="author-name font-bold text-sm dark:text-white truncate">${escapeHtml(displayName)}</div>
                    <div class="text-xs text-gray-400">${escapeHtml(time)}</div>
                </div>
                ${isAdmin ? `
                <button onclick="deleteUserPosts('${event.pubkey}')" 
                        class="text-xs text-red-500 hover:text-red-700 transition p-1.5 rounded-lg hover:bg-red-50 dark:hover:bg-red-500/10 shrink-0" 
                        title="حذف جميع منشورات هذا المستخدم (محلياً)">
                    <i class="fas fa-user-slash"></i>
                </button>
                ` : ''}
            </div>
            ${showDelete ? `
            <div class="flex gap-1 flex-shrink-0">
                ${isOwner ? `<button onclick="editPost('${event.id}')" class="text-xs text-blue-500 hover:text-blue-700 transition p-1.5 rounded-lg hover:bg-blue-50 dark:hover:bg-blue-500/10" title="تعديل"><i class="fas fa-edit"></i></button>` : ''}
                <button onclick="deletePost('${event.id}')" class="text-xs text-red-500 hover:text-red-700 transition p-1.5 rounded-lg hover:bg-red-50 dark:hover:bg-red-500/10" title="${isAdmin ? 'حذف (مشرف)' : 'حذف'}">
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

    processPendingReplies(event.id);
}

// ============================
// 11. حذف المنشور (مع صلاحيات المشرف)
// ============================

async function deletePost(postId) {
    if (!pk) { showToast('لا توجد هوية', 'error'); return; }
    const card = getPostCard(postId);
    if (!card) { showToast('المنشور غير موجود', 'error'); return; }
    const author = card.dataset.author;
    const isOwner = (author === pk);
    const isAdmin = (pk === adminPubkey);

    if (!isOwner && !isAdmin) {
        showToast('ليس لديك صلاحية حذف هذا المنشور', 'error');
        return;
    }

    if (isAdmin && !isOwner) {
        if (!confirm('أنت مشرف، هل تريد حذف هذا المنشور (محلياً فقط)؟')) return;
    } else {
        if (!confirm('هل أنت متأكد من حذف هذا المنشور؟')) return;
    }

    try {
        if (isOwner) {
            const event = await signEvent({ kind: 5, created_at: Math.floor(Date.now() / 1000), tags: [['e', postId]], content: '' });
            await pool.publish(RELAYS, event);
            showToast('تم حذف المنشور', 'success');
        } else {
            showToast('تم حذف المنشور محلياً بواسطة المشرف', 'info');
        }
        removePostFromUI(postId);
    } catch (error) {
        showToast('فشل الحذف: ' + getErrorMessage(error), 'error');
    }
}

// ============================
// 12. حذف جميع منشورات مستخدم (خاص بالمشرف)
// ============================

function deleteUserPosts(pubkey) {
    if (pk !== adminPubkey) {
        showToast('ليس لديك صلاحية لحذف مستخدم', 'error');
        return;
    }
    if (!pubkey) return;
    if (!confirm(`هل أنت متأكد من حذف جميع منشورات المستخدم ${getDisplayName(pubkey)}؟\nملاحظة: الحذف محلي ولن يؤثر على الشبكة.`)) return;

    // جمع جميع معرفات المنشورات لهذا المستخدم
    const toRemove = [];
    for (const [id, card] of renderedPosts) {
        if (card.dataset.author === pubkey) {
            toRemove.push(id);
        }
    }
    if (toRemove.length === 0) {
        showToast('لا توجد منشورات لهذا المستخدم', 'info');
        return;
    }

    // حذف كل منشور
    for (const id of toRemove) {
        removePostFromUI(id);
    }
    showToast(`تم حذف ${toRemove.length} منشور(ات) للمستخدم ${getDisplayName(pubkey)}`, 'success');
}

// ============================
// 13. إزالة منشور من الواجهة (دالة مساعدة)
// ============================

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
        // إزالة الإعجابات المرتبطة بهذا المنشور
        for (const [likeId, info] of likeEventIndex) {
            if (info.postId === postId) likeEventIndex.delete(likeId);
        }
    }
}

// ============================
// 14. تعديل المنشور
// ============================

// ... (نفس الكود السابق) ...

// ============================
// 15. نشر منشور مع رفع الملفات
// ============================

// ... (نفس الكود السابق) ...

// ============================
// 16. الإعجابات والردود
// ============================

// ... (نفس الكود السابق) ...

// ============================
// 17. غرف الصوت WebRTC
// ============================

// ... (نفس الكود السابق) ...

// ============================
// 18. اكتشاف الغرف الحية
// ============================

// ... (نفس الكود السابق) ...

// ============================
// 19. التنقل والمظهر
// ============================

// ... (نفس الكود السابق) ...

// ============================
// 20. تحميل المزيد
// ============================

// ... (نفس الكود السابق) ...

// ============================
// 21. دوال الصور المفقودة
// ============================

// ... (نفس الكود السابق) ...

// ============================
// 22. Boot
// ============================

// ... (نفس الكود السابق مع ربط الدوال الجديدة) ...

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
window.deleteUserPosts = deleteUserPosts;  // الدالة الجديدة
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
