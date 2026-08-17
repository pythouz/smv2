/* =========================================================
   Pulse - التطبيق الرئيسي
   نظام Nostr + المنشورات + غرف الصوت WebRTC
   ========================================================= */

const RELAYS = [
    'wss://relay.damus.io',
    'wss://relay.primal.net',
    'wss://nos.lol'
];

const APP_TAG = 'pulse-platform';
const ROOM_EVENT_KIND = 20000;

/* =========================================================
   الحالة العامة
   ========================================================= */

let secretKeyHex = null;
let pk = null;
let npub = null;

const storageKey = 'pulse_nsec_hex';

const pool = new NostrTools.SimplePool();

const seenEvents = new Set();
const renderedPosts = new Map();

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

    if (typeof error === 'string') {
        return error;
    }

    return error.message || error.type || 'خطأ غير معروف';
}

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
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

function initIdentity() {
    try {
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
        }

        /*
         * مهم:
         * nostr-tools v2 يقبل الـ Hex String مباشرة.
         * لا نحوله إلى Uint8Array عند finalizeEvent.
         */
        secretKeyHex = hexSk;

        pk = NostrTools.getPublicKey(secretKeyHex);
        npub = NostrTools.nip19.npubEncode(pk);

        if ($('npub-display')) {
            $('npub-display').textContent =
                npub.slice(0, 10) + '...' + npub.slice(-6);
        }

        console.log('[Nostr] الهوية جاهزة');
        console.log('[Nostr] Public Key:', pk);

    } catch (error) {
        console.error('[Nostr] فشل تهيئة الهوية:', error);

        localStorage.removeItem(storageKey);

        showToast(
            'حدث خطأ في الهوية، سيتم إنشاء هوية جديدة',
            'error'
        );

        setTimeout(initIdentity, 500);
    }
}


/* =========================================================
   المنشورات
   ========================================================= */

function startFeed() {
    console.log('[Feed] بدء الاشتراك في المنشورات');

    const loading = $('loading-feed');

    if (loading) {
        loading.classList.remove('hidden');
    }

    try {
        postsSubscription = pool.subscribeMany(
            RELAYS,
            [
                {
                    kinds: [1],
                    '#t': [APP_TAG],
                    limit: 50
                }
            ],
            {
                onevent: event => {
                    if (!event || !event.id) return;

                    /*
                     * الردود التي تحمل e tag للمنشور لا نريد
                     * عرضها كمنشورات رئيسية.
                     */
                    if (isReplyEvent(event)) {
                        handleIncomingReply(event);
                        return;
                    }

                    if (seenEvents.has(event.id)) {
                        return;
                    }

                    seenEvents.add(event.id);

                    renderPost(event);
                },

                oneose: () => {
                    console.log('[Feed] تم تحميل المنشورات الأولية');

                    if (loading) {
                        loading.classList.add('hidden');
                    }

                    startReactionSubscription();
                },

                onclose: () => {
                    console.log('[Feed] اشتراك المنشورات أغلق');
                }
            }
        );

    } catch (error) {
        console.error('[Feed] خطأ في subscribeMany:', error);

        if (loading) {
            loading.classList.add('hidden');
        }

        showToast(
            'تعذر الاتصال بشبكة المنشورات: ' +
            getErrorMessage(error),
            'error'
        );
    }
}

function isReplyEvent(event) {
    if (!event.tags) return false;

    return event.tags.some(tag =>
        tag[0] === 'e' &&
        tag[1]
    );
}

function getPostCard(postId) {
    return document.querySelector(
        `.post-card[data-post-id="${CSS.escape(postId)}"]`
    );
}

function renderPost(event) {
    const container = $('feed-container');

    if (!container) return;

    if (renderedPosts.has(event.id)) {
        return;
    }

    const shortPubkey = event.pubkey.slice(0, 8);

    const time = new Date(
        event.created_at * 1000
    ).toLocaleString('ar-EG', {
        hour: '2-digit',
        minute: '2-digit',
        day: 'numeric',
        month: 'short'
    });

    const div = document.createElement('div');

    div.className =
        'post-card bg-white dark:bg-surface rounded-2xl p-4 shadow-sm border border-gray-100 dark:border-gray-800 fade-in';

    div.dataset.postId = event.id;
    div.dataset.author = event.pubkey;

    div.innerHTML = `
        <div class="flex justify-between items-start mb-3">
            <div class="flex items-center gap-3">
                <div class="avatar w-10 h-10 bg-indigo-500 text-sm">
                    ${escapeHtml(shortPubkey)}
                </div>

                <div>
                    <div class="font-bold text-sm dark:text-white">
                        ${escapeHtml(shortPubkey)}...
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

                <span>
                    إعجاب
                </span>

                <span
                    class="like-count"
                    data-count="0"
                >
                    0
                </span>
            </button>

            <button
                class="reply-button flex items-center gap-2 hover:text-blue-500 transition"
                onclick="replyToPost('${event.id}', '${event.pubkey}')"
            >
                <i class="far fa-comment"></i>

                <span>رد</span>

                <span
                    class="reply-count"
                    data-count="0"
                >
                    0
                </span>
            </button>

        </div>

        <div
            class="replies-container mt-3 space-y-2"
            data-replies="${event.id}"
        ></div>
    `;

    renderedPosts.set(event.id, div);

    container.prepend(div);
}


/* =========================================================
   Optimistic UI + Real-time reactions
   ========================================================= */

function getReactionStats(postId) {
    const card = getPostCard(postId);

    if (!card) return null;

    const likeButton = card.querySelector('.like-button');
    const likeCount = card.querySelector('.like-count');
    const replyCount = card.querySelector('.reply-count');

    return {
        card,
        likeButton,
        likeCount,
        replyCount
    };
}

function updateLikeUI(postId, liked, countDelta = 0) {
    const stats = getReactionStats(postId);

    if (!stats) return;

    const currentCount =
        Number(stats.likeCount.dataset.count || 0);

    const newCount = Math.max(
        0,
        currentCount + countDelta
    );

    stats.likeCount.dataset.count = String(newCount);
    stats.likeCount.textContent = String(newCount);

    stats.likeButton.dataset.liked =
        liked ? 'true' : 'false';

    const icon = stats.likeButton.querySelector('i');

    if (liked) {
        stats.likeButton.classList.add(
            'text-red-500',
            'font-bold'
        );

        if (icon) {
            icon.className = 'fas fa-heart text-red-500';
        }
    } else {
        stats.likeButton.classList.remove(
            'text-red-500',
            'font-bold'
        );

        if (icon) {
            icon.className = 'far fa-heart';
        }
    }
}

async function likePost(targetId, targetPubkey) {
    const stats = getReactionStats(targetId);

    if (!stats) {
        showToast('تعذر العثور على المنشور', 'error');
        return;
    }

    const alreadyLiked =
        stats.likeButton.dataset.liked === 'true';

    if (alreadyLiked) {
        showToast('لقد أعجبت بهذا المنشور بالفعل', 'info');
        return;
    }

    /*
     * =====================================================
     * OPTIMISTIC UI
     *
     * نغير الواجهة فوراً قبل إرسال الحدث إلى Nostr.
     * المستخدم يرى القلب الأحمر والعداد فوراً.
     * =====================================================
     */

    updateLikeUI(
        targetId,
        true,
        1
    );

    stats.likeButton.classList.add('scale-110');

    setTimeout(() => {
        stats.likeButton.classList.remove('scale-110');
    }, 180);

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

        /*
         * nostr-tools v2:
         * secretKeyHex يتم تمريره مباشرة.
         */
        const signedEvent =
            NostrTools.finalizeEvent(
                eventTemplate,
                secretKeyHex
            );

        await pool.publish(
            RELAYS,
            signedEvent
        );

        console.log(
            '[Like] تم نشر الإعجاب:',
            signedEvent.id
        );

        showToast('تم الإعجاب ❤️', 'success');

    } catch (error) {
        console.error(
            '[Like] فشل نشر الإعجاب:',
            error
        );

        /*
         * لو فشل النشر نرجع Optimistic UI.
         */
        updateLikeUI(
            targetId,
            false,
            -1
        );

        showToast(
            'فشل إرسال الإعجاب: ' +
            getErrorMessage(error),
            'error'
        );
    }
}

function startReactionSubscription() {
    const postIds = Array.from(
        renderedPosts.keys()
    );

    if (!postIds.length) {
        return;
    }

    /*
     * نعيد إنشاء الاشتراك بناءً على المنشورات الموجودة
     * في DOM حالياً.
     */
    if (reactionsSubscription) {
        try {
            reactionsSubscription.close();
        } catch (error) {
            console.log(
                '[Reactions] تعذر إغلاق الاشتراك القديم',
                error
            );
        }
    }

    console.log(
        '[Reactions] الاستماع للتفاعلات:',
        postIds.length
    );

    try {
        reactionsSubscription = pool.subscribeMany(
            RELAYS,
            [
                {
                    kinds: [7, 1],
                    '#e': postIds,
                    limit: 500
                }
            ],
            {
                onevent: event => {
                    if (!event || !event.id) {
                        return;
                    }

                    if (event.kind === 7) {
                        handleIncomingLike(event);
                    }

                    if (event.kind === 1) {
                        handleIncomingReply(event);
                    }
                },

                oneose: () => {
                    console.log(
                        '[Reactions] تم تحميل التفاعلات الحالية'
                    );
                }
            }
        );

    } catch (error) {
        console.error(
            '[Reactions] خطأ في subscribeMany:',
            error
        );
    }
}

const processedLikes = new Set();

function handleIncomingLike(event) {
    if (processedLikes.has(event.id)) {
        return;
    }

    processedLikes.add(event.id);

    const targetId = getTagValue(
        event.tags,
        'e'
    );

    if (!targetId) {
        return;
    }

    const stats = getReactionStats(targetId);

    if (!stats) {
        return;
    }

    /*
     * لو كان الحدث من المستخدم الحالي،
     * الـ Optimistic UI قام بالزيادة بالفعل.
     *
     * لذلك لا نزيده مرة أخرى.
     */
    if (event.pubkey === pk) {
        return;
    }

    const currentCount =
        Number(stats.likeCount.dataset.count || 0);

    stats.likeCount.dataset.count =
        String(currentCount + 1);

    stats.likeCount.textContent =
        String(currentCount + 1);

    console.log(
        '[Like] إعجاب جديد:',
        targetId
    );
}

function getTagValue(tags, name) {
    if (!Array.isArray(tags)) {
        return null;
    }

    const tag = tags.find(
        item => item[0] === name
    );

    return tag ? tag[1] : null;
}

function handleIncomingReply(event) {
    const targetId = getTagValue(
        event.tags,
        'e'
    );

    if (!targetId) {
        return;
    }

    const stats = getReactionStats(targetId);

    if (!stats) {
        return;
    }

    const replyCount =
        Number(stats.replyCount.dataset.count || 0);

    /*
     * لا نكرر نفس الرد.
     */
    if (
        document.querySelector(
            `[data-reply-id="${CSS.escape(event.id)}"]`
        )
    ) {
        return;
    }

    stats.replyCount.dataset.count =
        String(replyCount + 1);

    stats.replyCount.textContent =
        String(replyCount + 1);

    /*
     * عرض الرد مباشرة أسفل المنشور.
     */
    const repliesContainer =
        stats.card.querySelector(
            `[data-replies="${CSS.escape(targetId)}"]`
        );

    if (!repliesContainer) {
        return;
    }

    const reply = document.createElement('div');

    reply.dataset.replyId = event.id;

    reply.className =
        'bg-gray-50 dark:bg-gray-800 rounded-xl p-3 text-sm';

    reply.innerHTML = `
        <div class="text-xs text-gray-400 mb-1">
            ${escapeHtml(event.pubkey.slice(0, 8))}...
        </div>

        <div class="text-gray-700 dark:text-gray-200">
            ${escapeHtml(event.content)}
        </div>
    `;

    repliesContainer.appendChild(reply);

    console.log(
        '[Reply] رد جديد:',
        event.id
    );
}

async function replyToPost(
    targetId,
    targetPubkey
) {
    const content = prompt('اكتب ردك:');

    if (!content || !content.trim()) {
        return;
    }

    const cleanContent = content.trim();

    try {
        const eventTemplate = {
            kind: 1,
            created_at: Math.floor(Date.now() / 1000),

            tags: [
                [
                    'e',
                    targetId,
                    '',
                    'reply'
                ],
                [
                    'p',
                    targetPubkey
                ],
                [
                    't',
                    APP_TAG
                ]
            ],

            content: cleanContent
        };

        const signedEvent =
            NostrTools.finalizeEvent(
                eventTemplate,
                secretKeyHex
            );

        /*
         * Optimistic UI للرد:
         * نعرضه فوراً.
         */
        handleIncomingReply(
            signedEvent
        );

        await pool.publish(
            RELAYS,
            signedEvent
        );

        showToast(
            'تم إرسال الرد',
            'success'
        );

    } catch (error) {
        console.error(
            '[Reply] فشل الرد:',
            error
        );

        showToast(
            'فشل إرسال الرد: ' +
            getErrorMessage(error),
            'error'
        );
    }
}


/* =========================================================
   =========================================================
   غرف الصوت WebRTC
   =========================================================
   ========================================================= */


/*
 * إعداد ICE قوي نسبياً للاتصالات المباشرة.
 *
 * STUN:
 * يساعد المتصفح على معرفة عنوانه العام.
 *
 * TURN:
 * يستخدم عندما يكون الاتصال المباشر بين الطرفين
 * مستحيلاً بسبب NAT/Firewall.
 *
 * ملاحظة:
 * الخوادم العامة ليست ضماناً 100% للإنتاج.
 * في الإنتاج الأفضل استخدام TURN خاص بك.
 */
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


/* =========================================================
   إنشاء PeerJS
   ========================================================= */

function createPeer() {
    return new Promise((resolve, reject) => {
        if (peer && !peer.destroyed) {
            resolve(peer);
            return;
        }

        const peerId =
            'pulse-' +
            pk.slice(0, 8) +
            '-' +
            Math.random()
                .toString(36)
                .slice(2, 8);

        console.log(
            '[WebRTC] إنشاء Peer:',
            peerId
        );

        let settled = false;

        try {
            peer = new Peer(
                peerId,
                {
                    /*
                     * نستخدم خادم PeerJS للـ signaling
                     * وليس لنقل الصوت.
                     */
                    host: '0.peerjs.com',
                    port: 443,
                    secure: true,
                    path: '/',
                    debug: 2,

                    /*
                     * أهم جزء:
                     * STUN/TURN للـ ICE.
                     */
                    config: WEBRTC_CONFIG
                }
            );

            peer.on(
                'open',
                id => {
                    myPeerId = id;

                    console.log(
                        '[WebRTC] Peer مفتوح:',
                        id
                    );

                    if (!settled) {
                        settled = true;
                        resolve(peer);
                    }
                }
            );

            peer.on(
                'call',
                call => {
                    console.log(
                        '[WebRTC] Incoming call من:',
                        call.peer
                    );

                    handleIncomingCall(call);
                }
            );

            peer.on(
                'error',
                error => {
                    console.error(
                        '[WebRTC] PeerJS Error:',
                        error
                    );

                    console.error(
                        '[WebRTC] نوع الخطأ:',
                        error.type
                    );

                    if (!settled) {
                        settled = true;
                        reject(error);
                    }

                    handlePeerError(error);
                }
            );

            peer.on(
                'disconnected',
                () => {
                    console.warn(
                        '[WebRTC] PeerJS disconnected'
                    );

                    showToast(
                        'انقطع اتصال خدمة الإشارة الصوتية',
                        'error'
                    );
                }
            );

            peer.on(
                'close',
                () => {
                    console.warn(
                        '[WebRTC] PeerJS connection closed'
                    );
                }
            );

        } catch (error) {
            console.error(
                '[WebRTC] فشل إنشاء Peer:',
                error
            );

            reject(error);
        }
    });
}

function handlePeerError(error) {
    const type = error?.type || '';
    const message = getErrorMessage(error);

    if (
        type === 'network' ||
        type === 'server-error' ||
        type === 'socket-error'
    ) {
        showToast(
            'مشكلة في شبكة الاتصال الصوتي: ' +
            message,
            'error'
        );

        return;
    }

    if (
        type === 'unavailable-id'
    ) {
        showToast(
            'معرف الاتصال الصوتي مستخدم، حاول مرة أخرى',
            'error'
        );

        return;
    }

    if (
        type === 'browser-incompatible'
    ) {
        showToast(
            'المتصفح لا يدعم WebRTC بشكل صحيح',
            'error'
        );

        return;
    }

    showToast(
        'خطأ WebRTC: ' + message,
        'error'
    );
}


/* =========================================================
   دخول الغرفة
   ========================================================= */

async function toggleRoom(forceLeave = false) {
    if (forceLeave) {
        await leaveRoom();
        return;
    }

    if (isJoiningRoom) {
        return;
    }

    /*
     * لو نحن بالفعل داخل الغرفة:
     * الزر يعني مغادرة.
     */
    if (currentRoom) {
        await leaveRoom();
        return;
    }

    const input = $('room-input');

    if (!input) {
        console.error(
            '[Room] room-input غير موجود'
        );
        return;
    }

    const roomName =
        safeRoomName(input.value);

    if (!roomName) {
        showToast(
            'اكتب اسم الغرفة أولاً',
            'error'
        );
        return;
    }

    await joinRoom(roomName);
}

async function joinRoom(roomName) {
    if (isJoiningRoom) {
        return;
    }

    isJoiningRoom = true;

    console.log(
        '[Room] محاولة دخول:',
        roomName
    );

    try {
        /*
         * -------------------------------------------------
         * 1. الحصول على المايك
         * -------------------------------------------------
         */

        if (
            !navigator.mediaDevices ||
            !navigator.mediaDevices.getUserMedia
        ) {
            throw new Error(
                'المتصفح لا يدعم getUserMedia أو الصفحة ليست HTTPS'
            );
        }

        showToast(
            'جاري تشغيل الميكروفون...',
            'info'
        );

        try {
            localStream =
                await navigator.mediaDevices.getUserMedia({
                    audio: {
                        echoCancellation: true,
                        noiseSuppression: true,
                        autoGainControl: true,
                        channelCount: 1
                    }
                });

        } catch (micError) {
            console.error(
                '[Room] فشل المايك:',
                micError
            );

            if (
                micError.name === 'NotAllowedError'
            ) {
                throw new Error(
                    'تم رفض صلاحية الميكروفون. اسمح للمتصفح باستخدام الميكروفون.'
                );
            }

            if (
                micError.name === 'NotFoundError'
            ) {
                throw new Error(
                    'لم يتم العثور على ميكروفون في الجهاز.'
                );
            }

            if (
                micError.name === 'NotReadableError'
            ) {
                throw new Error(
                    'الميكروفون مستخدم بواسطة تطبيق أو متصفح آخر.'
                );
            }

            throw micError;
        }

        console.log(
            '[Room] المايك يعمل:',
            localStream.getAudioTracks().map(track => ({
                label: track.label,
                enabled: track.enabled,
                readyState: track.readyState
            }))
        );


        /*
         * -------------------------------------------------
         * 2. إنشاء PeerJS
         * -------------------------------------------------
         */

        await createPeer();

        if (!peer || peer.destroyed) {
            throw new Error(
                'تعذر إنشاء PeerJS'
            );
        }


        /*
         * -------------------------------------------------
         * 3. تثبيت حالة الغرفة
         * -------------------------------------------------
         */

        currentRoom = roomName;

        localStorage.setItem(
            'active_room',
            currentRoom
        );

        announcedPeers.clear();

        /*
         * -------------------------------------------------
         * 4. تحديث الواجهة
         * -------------------------------------------------
         */

        updateRoomUI(true);

        /*
         * -------------------------------------------------
         * 5. تشغيل الصوت الخلفي
         * -------------------------------------------------
         */

        startBackgroundAudioEngine();

        /*
         * -------------------------------------------------
         * 6. منع إيقاف الشاشة قدر الإمكان
         * -------------------------------------------------
         */

        requestSystemLock();

        /*
         * -------------------------------------------------
         * 7. بدء VAD
         * -------------------------------------------------
         */

        setupVAD();

        /*
         * -------------------------------------------------
         * 8. الإعلان عن وجودنا في Nostr
         * -------------------------------------------------
         */

        await announcePresence();

        /*
         * -------------------------------------------------
         * 9. الاستماع لباقي الموجودين
         * -------------------------------------------------
         */

        listenForPeers();

        showToast(
            'دخلت غرفة "' + roomName + '" 🎙️',
            'success'
        );

        console.log(
            '[Room] تم الدخول بنجاح:',
            roomName
        );

    } catch (error) {
        console.error(
            '[Room] فشل دخول الغرفة:',
            error
        );

        showToast(
            'فشل دخول الغرفة: ' +
            getErrorMessage(error),
            'error'
        );

        /*
         * تنظيف أي موارد تم تشغيلها قبل الفشل.
         */
        cleanupRoomResources(false);

    } finally {
        isJoiningRoom = false;
    }
}


/* =========================================================
   UI الغرفة
   ========================================================= */

function updateRoomUI(joined) {
    const btn = $('btn-join-room');
    const input = $('room-input');
    const activeUi = $('active-room-ui');

    if (joined) {
        if (activeUi) {
            activeUi.classList.remove('hidden');
        }

        if (btn) {
            btn.textContent = 'مغادرة';

            btn.classList.remove(
                'bg-white',
                'text-accent'
            );

            btn.classList.add(
                'bg-red-500',
                'text-white'
            );
        }

        if (input) {
            input.disabled = true;
        }

        if ($('current-room-name')) {
            $('current-room-name').textContent =
                `غرفة: ${currentRoom}`;
        }

    } else {
        if (activeUi) {
            activeUi.classList.add('hidden');
        }

        if (btn) {
            btn.textContent = 'دخول';

            btn.classList.remove(
                'bg-red-500',
                'text-white'
            );

            btn.classList.add(
                'bg-white',
                'text-accent'
            );
        }

        if (input) {
            input.disabled = false;
        }
    }
}


/* =========================================================
   Nostr Signaling
   ========================================================= */

function roomTag() {
    /*
     * Tag فريد جداً للغرفة.
     *
     * لا نستخدم مجرد room لأن تطبيقات أخرى على Nostr
     * قد تستخدم نفس الاسم.
     */
    return `${APP_TAG}:voice:${safeRoomName(currentRoom)}`;
}

async function announcePresence() {
    if (!currentRoom || !myPeerId) {
        return;
    }

    const tag = roomTag();

    const eventTemplate = {
        kind: ROOM_EVENT_KIND,

        created_at:
            Math.floor(Date.now() / 1000),

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
        /*
         * مهم:
         * finalizeEvent في nostr-tools v2
         * يأخذ Hex String مباشرة.
         */
        const event =
            NostrTools.finalizeEvent(
                eventTemplate,
                secretKeyHex
            );

        console.log(
            '[Nostr Room] نشر presence:',
            {
                eventId: event.id,
                room: currentRoom,
                tag,
                peerId: myPeerId
            }
        );

        await pool.publish(
            RELAYS,
            event
        );

    } catch (error) {
        console.error(
            '[Nostr Room] فشل نشر presence:',
            error
        );

        showToast(
            'تم تشغيل الغرفة لكن تعذر إعلان وجودك للشبكة',
            'error'
        );
    }
}


/* =========================================================
   الاستماع للمشاركين
   ========================================================= */

function listenForPeers() {
    if (!currentRoom) {
        return;
    }

    if (roomSubscription) {
        try {
            roomSubscription.close();
        } catch (error) {
            console.log(
                '[Room] تعذر إغلاق اشتراك الغرفة السابق'
            );
        }
    }

    const tag = roomTag();

    console.log(
        '[Nostr Room] الاستماع للغرفة:',
        currentRoom
    );

    console.log(
        '[Nostr Room] Tag:',
        tag
    );

    /*
     * subscribeMany:
     *
     * نطلب أحداث kind 20000 التي تحمل
     * #t = tag الخاص بهذه الغرفة.
     *
     * هذا يجعل كل شخص جديد يعلن نفسه فوراً،
     * كما نحصل على المشاركين الموجودين بالفعل.
     */
    try {
        roomSubscription =
            pool.subscribeMany(
                RELAYS,
                [
                    {
                        kinds: [
                            ROOM_EVENT_KIND
                        ],

                        '#t': [tag],

                        limit: 100
                    }
                ],
                {
                    onevent: event => {
                        handleRoomPresence(event);
                    },

                    oneose: () => {
                        console.log(
                            '[Nostr Room] تم تحميل المشاركين الحاليين'
                        );
                    },

                    onclose: () => {
                        console.log(
                            '[Nostr Room] اشتراك الغرفة أغلق'
                        );
                    }
                }
            );

    } catch (error) {
        console.error(
            '[Nostr Room] subscribeMany Error:',
            error
        );

        showToast(
            'فشل نظام اكتشاف المشاركين: ' +
            getErrorMessage(error),
            'error'
        );
    }
}

function handleRoomPresence(event) {
    if (!currentRoom) {
        return;
    }

    if (!event || !event.content) {
        return;
    }

    if (event.pubkey === pk) {
        return;
    }

    let data;

    try {
        data = JSON.parse(
            event.content
        );
    } catch (error) {
        console.warn(
            '[Nostr Room] Presence غير صالح:',
            event.content
        );
        return;
    }

    if (!data.peerId) {
        return;
    }

    if (
        data.room &&
        safeRoomName(data.room) !==
        safeRoomName(currentRoom)
    ) {
        return;
    }

    if (
        announcedPeers.has(data.peerId)
    ) {
        return;
    }

    announcedPeers.add(data.peerId);

    console.log(
        '[Room] مشارك جديد:',
        {
            peerId: data.peerId,
            npub: data.npub
        }
    );

    /*
     * منع إنشاء اتصالين في الاتجاهين.
     *
     * الطرف الذي يملك Peer ID الأصغر هو الذي يبدأ المكالمة.
     *
     * هذا مهم جداً لأن الطرفين يحصلان على Presence
     * في نفس الوقت.
     */
    if (
        myPeerId &&
        myPeerId < data.peerId
    ) {
        connectToPeer(
            data.peerId,
            data.npub || data.peerId
        );
    }
}


/* =========================================================
   إنشاء المكالمة
   ========================================================= */

function connectToPeer(
    targetPeerId,
    displayName
) {
    if (!peer || peer.destroyed) {
        console.error(
            '[WebRTC] لا يمكن الاتصال: Peer غير جاهز'
        );
        return;
    }

    if (!localStream) {
        console.error(
            '[WebRTC] لا يمكن الاتصال: localStream غير موجود'
        );
        return;
    }

    if (!currentRoom) {
        return;
    }

    if (targetPeerId === myPeerId) {
        return;
    }

    if (activeCalls.has(targetPeerId)) {
        return;
    }

    console.log(
        '[WebRTC] بدء اتصال مع:',
        targetPeerId
    );

    let call;

    try {
        call =
            peer.call(
                targetPeerId,
                localStream,
                {
                    metadata: {
                        room: currentRoom,
                        caller: myPeerId
                    }
                }
            );

    } catch (error) {
        console.error(
            '[WebRTC] peer.call فشل:',
            error
        );

        showToast(
            'تعذر بدء الاتصال الصوتي مع مشارك',
            'error'
        );

        return;
    }

    if (!call) {
        console.error(
            '[WebRTC] PeerJS لم ينشئ Call'
        );
        return;
    }

    handleCallEvents(
        call,
        displayName
    );
}


/* =========================================================
   Incoming Call
   ========================================================= */

function handleIncomingCall(call) {
    if (!currentRoom) {
        console.log(
            '[WebRTC] تجاهل اتصال لأن المستخدم خارج الغرفة'
        );

        try {
            call.close();
        } catch (error) {}

        return;
    }

    if (!localStream) {
        console.error(
            '[WebRTC] Incoming call لكن localStream غير موجود'
        );

        try {
            call.close();
        } catch (error) {}

        return;
    }

    /*
     * لو الاتصال موجود بالفعل، لا ننشئ نسخة ثانية.
     */
    if (activeCalls.has(call.peer)) {
        console.log(
            '[WebRTC] اتصال موجود بالفعل مع:',
            call.peer
        );

        try {
            call.close();
        } catch (error) {}

        return;
    }

    console.log(
        '[WebRTC] الرد على المكالمة من:',
        call.peer
    );

    try {
        call.answer(localStream);

        handleCallEvents(
            call,
            call.peer
        );

    } catch (error) {
        console.error(
            '[WebRTC] فشل الرد على المكالمة:',
            error
        );

        try {
            call.close();
        } catch (closeError) {}
    }
}


/* =========================================================
   إدارة المكالمة
   ========================================================= */

function handleCallEvents(
    call,
    displayName
) {
    if (!call) {
        return;
    }

    const peerId = call.peer;

    activeCalls.set(
        peerId,
        call
    );

    console.log(
        '[WebRTC] Call registered:',
        peerId
    );

    call.on(
        'stream',
        remoteStream => {
            console.log(
                '[WebRTC] تم استقبال Remote Stream:',
                peerId
            );

            addPeerAudio(
                remoteStream,
                peerId,
                displayName
            );
        }
    );

    call.on(
        'close',
        () => {
            console.log(
                '[WebRTC] المكالمة أغلقت:',
                peerId
            );

            removePeerCall(
                peerId
            );
        }
    );

    call.on(
        'error',
        error => {
            console.error(
                '[WebRTC] Call Error:',
                peerId,
                error
            );

            showToast(
                'انقطع اتصال أحد المشاركين: ' +
                getErrorMessage(error),
                'error'
            );

            removePeerCall(
                peerId
            );
        }
    );
}


/* =========================================================
   استقبال الصوت
   ========================================================= */

function addPeerAudio(
    stream,
    peerId,
    displayName
) {
    if (!stream) {
        console.error(
            '[Audio] Remote stream فارغ:',
            peerId
        );
        return;
    }

    let audio =
        document.getElementById(
            `audio-${peerId}`
        );

    if (!audio) {
        audio =
            document.createElement('audio');

        audio.id =
            `audio-${peerId}`;

        audio.autoplay = true;
        audio.playsInline = true;
        audio.setAttribute(
            'playsinline',
            ''
        );

        /*
         * مهم جداً:
         * لا نستخدم controls للمستخدم.
         */
        audio.controls = false;

        /*
         * volume = 1
         * حتى لا تكون المشكلة مجرد volume = 0.
         */
        audio.volume = 1;

        /*
         * نضعه في audio-container إن وجد.
         */
        const container =
            $('audio-container');

        if (container) {
            container.appendChild(audio);
        } else {
            document.body.appendChild(audio);
        }
    }

    audio.srcObject = stream;

    /*
     * تشغيل الصوت فور وصول stream.
     */
    const playPromise =
        audio.play();

    if (playPromise) {
        playPromise
            .then(() => {
                console.log(
                    '[Audio] الصوت يعمل:',
                    peerId
                );

                updatePeerCount();
            })
            .catch(error => {
                console.error(
                    '[Audio] Browser منع autoplay:',
                    error
                );

                showToast(
                    'تم الاتصال بالمشارك لكن المتصفح منع تشغيل الصوت. اضغط داخل الصفحة ثم أعد المحاولة.',
                    'error'
                );

                /*
                 * محاولة ثانية بعد تفاعل المستخدم.
                 */
                document.addEventListener(
                    'click',
                    () => {
                        audio.play()
                            .catch(() => {});
                    },
                    {
                        once: true
                    }
                );
            });
    }

    addPeerToUI(
        peerId,
        displayName
    );

    updatePeerCount();
}


/* =========================================================
   واجهة المشاركين
   ========================================================= */

function addPeerToUI(
    peerId,
    displayName
) {
    const list =
        $('peers-list');

    if (!list) {
        return;
    }

    const id =
        `participant-${peerId}`;

    if (
        document.getElementById(id)
    ) {
        return;
    }

    const div =
        document.createElement('div');

    div.id = id;

    div.className =
        'flex items-center gap-2 bg-gray-50 dark:bg-gray-800 p-2 rounded-lg';

    const safeName =
        String(
            displayName || peerId
        ).slice(0, 12);

    div.innerHTML = `
        <div class="w-2 h-2 bg-green-500 rounded-full animate-pulse"></div>

        <span>
            ${escapeHtml(safeName)}...
        </span>
    `;

    list.appendChild(div);
}

function removePeerCall(peerId) {
    const audio =
        document.getElementById(
            `audio-${peerId}`
        );

    if (audio) {
        try {
            audio.pause();
        } catch (error) {}

        audio.srcObject = null;
        audio.remove();
    }

    const participant =
        document.getElementById(
            `participant-${peerId}`
        );

    if (participant) {
        participant.remove();
    }

    activeCalls.delete(
        peerId
    );

    updatePeerCount();
}

function updatePeerCount() {
    const count =
        $('peers-list')?.children.length ||
        activeCalls.size;

    /*
     * لا يوجد peer-count في index الحالي،
     * لذلك نحدثه فقط لو كان موجوداً.
     */
    const countElement =
        $('peer-count');

    if (countElement) {
        countElement.textContent =
            `الأشخاص: ${count}`;
    }
}


/* =========================================================
   كتم الميكروفون
   ========================================================= */

function toggleMute() {
    if (!localStream) {
        showToast(
            'لا يوجد ميكروفون نشط',
            'error'
        );
        return;
    }

    const tracks =
        localStream.getAudioTracks();

    if (!tracks.length) {
        showToast(
            'لم يتم العثور على مسار صوتي',
            'error'
        );
        return;
    }

    isMuted = !isMuted;

    tracks.forEach(
        track => {
            track.enabled =
                !isMuted;
        }
    );

    const btn =
        $('btn-mute');

    if (!btn) {
        return;
    }

    btn.innerHTML = isMuted
        ? '<i class="fas fa-microphone-slash text-red-500"></i>'
        : '<i class="fas fa-microphone"></i>';

    btn.classList.toggle(
        'bg-red-100',
        isMuted
    );

    btn.classList.toggle(
        'text-red-500',
        isMuted
    );

    showToast(
        isMuted
            ? 'تم كتم الميكروفون'
            : 'تم تشغيل الميكروفون',
        'success'
    );
}


/* =========================================================
   تنظيف الغرفة
   ========================================================= */

async function leaveRoom() {
    console.log(
        '[Room] مغادرة الغرفة:',
        currentRoom
    );

    const previousRoom =
        currentRoom;

    currentRoom = null;

    localStorage.removeItem(
        'active_room'
    );

    cleanupRoomResources(
        true
    );

    updateRoomUI(
        false
    );

    showToast(
        previousRoom
            ? 'تمت مغادرة الغرفة'
            : 'تم الخروج',
        'success'
    );
}

function cleanupRoomResources(
    destroyPeer = true
) {
    /*
     * إغلاق Nostr room subscription.
     */
    if (roomSubscription) {
        try {
            roomSubscription.close();
        } catch (error) {}

        roomSubscription = null;
    }

    announcedPeers.clear();

    /*
     * إغلاق كل المكالمات.
     */
    activeCalls.forEach(
        call => {
            try {
                call.close();
            } catch (error) {}
        }
    );

    activeCalls.clear();

    /*
     * إزالة كل audio.
     */
    document
        .querySelectorAll(
            '#audio-container audio, body > audio[id^="audio-"]'
        )
        .forEach(audio => {
            try {
                audio.pause();
            } catch (error) {}

            audio.srcObject = null;
            audio.remove();
        });

    /*
     * إيقاف المايك.
     */
    if (localStream) {
        localStream
            .getTracks()
            .forEach(track => {
                track.stop();
            });

        localStream = null;
    }

    /*
     * PeerJS.
     */
    if (
        destroyPeer &&
        peer
    ) {
        try {
            peer.destroy();
        } catch (error) {
            console.error(
                '[WebRTC] فشل destroy:',
                error
            );
        }

        peer = null;
        myPeerId = null;
    }

    /*
     * AudioContext.
     */
    if (bgAudioContext) {
        try {
            bgAudioContext.close();
        } catch (error) {}

        bgAudioContext = null;
    }

    if (silentAudioElement) {
        try {
            silentAudioElement.pause();
        } catch (error) {}

        silentAudioElement.remove();

        silentAudioElement = null;
    }

    if (wakeLock) {
        try {
            wakeLock.release();
        } catch (error) {}

        wakeLock = null;
    }

    isMuted = false;

    const list =
        $('peers-list');

    if (list) {
        list.innerHTML = '';
    }

    const muteButton =
        $('btn-mute');

    if (muteButton) {
        muteButton.innerHTML =
            '<i class="fas fa-microphone"></i>';

        muteButton.classList.remove(
            'bg-red-100',
            'text-red-500'
        );
    }
}


/* =========================================================
   Audio Keep Alive
   ========================================================= */

function startBackgroundAudioEngine() {
    try {
        if (
            !bgAudioContext
        ) {
            const AudioContext =
                window.AudioContext ||
                window.webkitAudioContext;

            if (!AudioContext) {
                console.warn(
                    '[Audio] AudioContext غير مدعوم'
                );

                return;
            }

            bgAudioContext =
                new AudioContext();

            if (
                bgAudioContext.state ===
                'suspended'
            ) {
                bgAudioContext.resume()
                    .catch(() => {});
            }

            /*
             * Oscillator شبه صامت.
             *
             * الهدف ليس تشغيل صوت مسموع،
             * بل إبقاء AudioContext نشطاً قدر الإمكان.
             */
            const oscillator =
                bgAudioContext.createOscillator();

            const gain =
                bgAudioContext.createGain();

            gain.gain.value =
                0.00001;

            oscillator.connect(
                gain
            );

            gain.connect(
                bgAudioContext.destination
            );

            oscillator.start();

            silentAudioElement =
                document.createElement('audio');

            silentAudioElement.id =
                'voice-keepalive';

            silentAudioElement.autoplay =
                true;

            silentAudioElement.playsInline =
                true;

            silentAudioElement.muted =
                true;

            document.body.appendChild(
                silentAudioElement
            );

            silentAudioElement.play()
                .catch(() => {});

        } else if (
            bgAudioContext.state ===
            'suspended'
        ) {
            bgAudioContext.resume()
                .catch(() => {});
        }

    } catch (error) {
        console.error(
            '[Audio] KeepAlive Error:',
            error
        );
    }
}


/* =========================================================
   Wake Lock
   ========================================================= */

async function requestSystemLock() {
    try {
        if (
            'wakeLock' in navigator
        ) {
            wakeLock =
                await navigator.wakeLock.request(
                    'screen'
                );

            console.log(
                '[Room] Wake Lock activated'
            );
        }
    } catch (error) {
        console.warn(
            '[Room] Wake Lock غير متاح:',
            error
        );
    }
}


/* =========================================================
   Voice Activity Detection
   ========================================================= */

function setupVAD() {
    if (!localStream) {
        return;
    }

    try {
        const AudioContext =
            window.AudioContext ||
            window.webkitAudioContext;

        if (!AudioContext) {
            return;
        }

        const audioContext =
            new AudioContext();

        const source =
            audioContext.createMediaStreamSource(
                localStream
            );

        const analyser =
            audioContext.createAnalyser();

        analyser.fftSize = 256;

        source.connect(
            analyser
        );

        const data =
            new Uint8Array(
                analyser.frequencyBinCount
            );

        const interval =
            setInterval(() => {
                if (!currentRoom) {
                    clearInterval(interval);

                    try {
                        audioContext.close();
                    } catch (error) {}

                    return;
                }

                if (isMuted) {
                    return;
                }

                analyser.getByteFrequencyData(
                    data
                );

                const volume =
                    data.reduce(
                        (sum, value) =>
                            sum + value,
                        0
                    ) / data.length;

                /*
                 * لا يوجد عنصر VAD في index الحالي،
                 * لذلك نحدثه فقط لو موجود.
                 */
                const status =
                    $('vad-status');

                if (status) {
                    status.textContent =
                        volume > 12
                            ? 'الحالة: تتحدث الآن 🎙️'
                            : 'الحالة: متصل (صامت)';
                }

            }, 200);

    } catch (error) {
        console.error(
            '[VAD] Error:',
            error
        );
    }
}


/* =========================================================
   إعادة الدخول بعد Refresh
   ========================================================= */

async function restoreRoomAfterRefresh() {
    const savedRoom =
        localStorage.getItem(
            'active_room'
        );

    if (!savedRoom) {
        return;
    }

    console.log(
        '[Room] غرفة محفوظة بعد Refresh:',
        savedRoom
    );

    const input =
        $('room-input');

    if (input) {
        input.value =
            savedRoom;
    }

    /*
     * مهم جداً:
     *
     * لا نضع currentRoom = savedRoom هنا.
     *
     * لأن joinRoom() يحتاج currentRoom === null
     * ليعرف أننا لسنا داخل غرفة.
     */
    currentRoom = null;

    /*
     * ننتظر قليلاً حتى تكون هوية Nostr و PeerJS جاهزين.
     */
    await sleep(800);

    /*
     * بسبب قيود المتصفح:
     * getUserMedia بعد Refresh قد يحتاج تفاعل المستخدم.
     *
     * لذلك نحاول أولاً.
     */
    try {
        await joinRoom(
            safeRoomName(savedRoom)
        );

    } catch (error) {
        console.error(
            '[Room] فشل إعادة الدخول التلقائي:',
            error
        );

        showToast(
            'كانت لديك غرفة مفتوحة قبل التحديث. اضغط "دخول" لإعادة الاتصال.',
            'info'
        );
    }
}


/* =========================================================
   التنقل
   ========================================================= */

function switchView(viewName) {
    document
        .querySelectorAll('.view-section')
        .forEach(section => {
            section.classList.add(
                'hidden'
            );
        });

    const target =
        $(`view-${viewName}`);

    if (target) {
        target.classList.remove(
            'hidden'
        );
    }

    document
        .querySelectorAll('.nav-btn')
        .forEach(button => {
            button.classList.remove(
                'text-accent',
                'active'
            );

            button.classList.add(
                'text-gray-400'
            );
        });

    const active =
        $(`nav-${viewName}`);

    if (active) {
        active.classList.add(
            'text-accent',
            'active'
        );

        active.classList.remove(
            'text-gray-400'
        );
    }
}

function toggleTheme() {
    document.documentElement.classList.toggle(
        'dark'
    );

    localStorage.setItem(
        'theme',
        document.documentElement.classList.contains(
            'dark'
        )
            ? 'dark'
            : 'light'
    );
}


/* =========================================================
   فحص WebRTC
   ========================================================= */

function runWebRTCDiagnostics() {
    console.log(
        '================ WebRTC Diagnostics ================'
    );

    console.log(
        '[WebRTC] HTTPS:',
        location.protocol === 'https:'
    );

    console.log(
        '[WebRTC] getUserMedia:',
        !!navigator.mediaDevices?.getUserMedia
    );

    console.log(
        '[WebRTC] RTCPeerConnection:',
        !!window.RTCPeerConnection
    );

    console.log(
        '[WebRTC] PeerJS:',
        typeof Peer !== 'undefined'
    );

    console.log(
        '[WebRTC] Current Room:',
        currentRoom
    );

    console.log(
        '[WebRTC] Peer ID:',
        myPeerId
    );

    console.log(
        '===================================================='
    );
}


/* =========================================================
   Boot
   ========================================================= */

document.addEventListener(
    'DOMContentLoaded',
    async () => {

        console.log(
            '[Pulse] بدء تشغيل التطبيق'
        );

        /*
         * Theme
         */
        if (
            localStorage.getItem('theme') ===
            'dark' ||
            (
                !localStorage.getItem('theme') &&
                window.matchMedia(
                    '(prefers-color-scheme: dark)'
                ).matches
            )
        ) {
            document.documentElement.classList.add(
                'dark'
            );
        }

        /*
         * الهوية
         */
        initIdentity();

        /*
         * المنشورات
         */
        startFeed();

        /*
         * PeerJS يتم إنشاؤه عند الحاجة
         * وليس بمجرد فتح الصفحة.
         */

        runWebRTCDiagnostics();

        /*
         * استعادة الغرفة بعد Refresh.
         *
         * لاحظ أننا لا ننفذ toggleRoom()
         * مباشرة.
         */
        const savedRoom =
            localStorage.getItem(
                'active_room'
            );

        if (savedRoom) {
            setTimeout(
                () => {
                    restoreRoomAfterRefresh();
                },
                1200
            );
        }
    }
);


/* =========================================================
   Service Worker
   ========================================================= */

if (
    'serviceWorker' in navigator
) {
    window.addEventListener(
        'load',
        () => {
            navigator.serviceWorker
                .register('./sw.js')
                .then(() => {
                    console.log(
                        '[SW] Service Worker Registered'
                    );
                })
                .catch(error => {
                    console.warn(
                        '[SW] Service Worker Failed:',
                        error
                    );
                });
        }
    );
}


/* =========================================================
   جعل الدوال متاحة لأزرار HTML
   ========================================================= */

window.publishPost = publishPost;
window.likePost = likePost;
window.replyToPost = replyToPost;

window.toggleRoom = toggleRoom;
window.toggleMute = toggleMute;

window.switchView = switchView;
window.toggleTheme = toggleTheme;

window.showToast = showToast;
