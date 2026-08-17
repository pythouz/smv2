/* ============================================================
   Pulse
   تطبيق مجتمع لامركزي باستخدام Nostr + WebRTC
   ============================================================ */


/* ============================================================
   إعدادات Nostr
   ============================================================ */

const RELAYS = [
    'wss://relay.damus.io',
    'wss://relay.primal.net',
    'wss://nos.lol'
];

const APP_TAG = 'pulse-platform';

const ROOM_TAG = 'pulse-room';

const ROOM_PRESENCE_TAG =
    'pulse-room-presence';

const ROOM_PRESENCE_TTL =
    45 * 1000;

const ROOM_HEARTBEAT_INTERVAL =
    20 * 1000;


/* ============================================================
   الهوية
   ============================================================ */

let secretKeyHex = null;
let pk = null;
let npub = null;

const storageKey =
    'pulse_nsec_hex';


/* ============================================================
   Nostr Pool
   ============================================================ */

const pool =
    new NostrTools.SimplePool();


/* ============================================================
   Feed State
   ============================================================ */

const seenEvents =
    new Set();

const postState =
    new Map();

let feedSubscription =
    null;

let interactionSubscription =
    null;


/* ============================================================
   Rooms State
   ============================================================ */

const roomsState = {

    rooms:
        new Map(),

    subscription:
        null,

    cleanupTimer:
        null,

    heartbeatTimer:
        null
};


/* ============================================================
   WebRTC State
   ============================================================ */

let localStream =
    null;

let peer =
    null;

let currentRoom =
    null;

let roomSub =
    null;

let isMuted =
    false;


/*
 * الاتصالات الحالية مع المشاركين.
 *
 * key = Peer ID
 * value = Call
 */
const activeCalls =
    new Map();


/*
 * Streams الحالية.
 */
const remoteStreams =
    new Map();


/* ============================================================
   تهيئة الهوية
   ============================================================ */

function initIdentity() {

    try {

        let hexSk =
            localStorage.getItem(
                storageKey
            );


        /*
         * التحقق من المفتاح الموجود.
         */
        const isValidHex =
            typeof hexSk === 'string' &&
            hexSk.length === 64 &&
            /^[0-9a-fA-F]{64}$/.test(
                hexSk
            );


        /*
         * إنشاء هوية جديدة إذا لم توجد.
         */
        if (!isValidHex) {

            console.log(
                '[Identity] إنشاء هوية Nostr جديدة...'
            );

            const newSkUint8 =
                NostrTools.generateSecretKey();


            hexSk =
                Array
                    .from(newSkUint8)
                    .map(
                        byte =>
                            byte
                                .toString(16)
                                .padStart(
                                    2,
                                    '0'
                                )
                    )
                    .join('');


            localStorage.setItem(
                storageKey,
                hexSk
            );
        }


        /*
         * مهم:
         *
         * نحتفظ بالمفتاح كـ Hex String.
         *
         * لا نحوله إلى Uint8Array عند finalizeEvent.
         */
        secretKeyHex =
            hexSk;


        pk =
            NostrTools.getPublicKey(
                secretKeyHex
            );


        npub =
            NostrTools.nip19.npubEncode(
                pk
            );


        const display =
            document.getElementById(
                'npub-display'
            );


        if (display) {

            display.textContent =
                npub.slice(0, 8) +
                '...' +
                npub.slice(-6);
        }


        console.log(
            '[Identity] تم تحميل الهوية:',
            npub
        );

    } catch (error) {

        console.error(
            '[Identity] خطأ حرج:',
            error
        );

        localStorage.removeItem(
            storageKey
        );

        showToast(
            'حدث خطأ في إنشاء الهوية',
            'error'
        );
    }
}


/* ============================================================
   نشر Event على Nostr
   ============================================================ */

async function publishSignedEvent(
    eventTemplate
) {

    if (!secretKeyHex) {

        throw new Error(
            'هوية Nostr غير جاهزة'
        );
    }


    /*
     * nostr-tools v2:
     * finalizeEvent يقبل Hex String مباشرة.
     */
    const signedEvent =
        NostrTools.finalizeEvent(
            eventTemplate,
            secretKeyHex
        );


    /*
     * SimplePool.publish يعيد مجموعة
     * من الوعود الخاصة بالـRelays.
     */
    const results =
        await Promise.allSettled(
            pool.publish(
                RELAYS,
                signedEvent
            )
        );


    const successful =
        results.filter(
            result =>
                result.status ===
                'fulfilled'
        );


    return {
        event:
            signedEvent,

        results,

        successCount:
            successful.length
    };
}


/* ============================================================
   Feed
   ============================================================ */

function startFeed() {

    const loading =
        document.getElementById(
            'loading-feed'
        );


    if (loading) {
        loading.classList.remove(
            'hidden'
        );
    }


    if (feedSubscription) {

        try {
            feedSubscription.close();
        } catch (_) {}

        feedSubscription =
            null;
    }


    console.log(
        '[Feed] بدء الاشتراك في المنشورات...'
    );


    feedSubscription =
        pool.subscribeMany(
            RELAYS,
            [
                {
                    kinds: [1],

                    '#t': [
                        APP_TAG
                    ],

                    limit: 50
                }
            ],
            {

                onevent(event) {

                    /*
                     * منع تكرار نفس المنشور
                     * بسبب وجود أكثر من Relay.
                     */
                    if (
                        seenEvents.has(
                            event.id
                        )
                    ) {
                        return;
                    }


                    seenEvents.add(
                        event.id
                    );


                    renderPost(
                        event
                    );


                    /*
                     * بعد وصول منشور جديد،
                     * نعيد مراقبة التفاعلات.
                     */
                    refreshInteractionSubscription();
                },


                oneose() {

                    if (loading) {

                        loading.classList.add(
                            'hidden'
                        );
                    }


                    console.log(
                        '[Feed] انتهى تحميل المنشورات.'
                    );


                    refreshInteractionSubscription();
                },


                onclose(reason) {

                    console.warn(
                        '[Feed] تم إغلاق الاشتراك:',
                        reason
                    );
                }
            }
        );
}


/* ============================================================
   رسم المنشور
   ============================================================ */

function renderPost(event) {

    const container =
        document.getElementById(
            'feed-container'
        );


    if (!container) {
        return;
    }


    /*
     * منع تكرار DOM.
     */
    if (
        document.querySelector(
            `[data-post-id="${event.id}"]`
        )
    ) {
        return;
    }


    const shortPubkey =
        event.pubkey.slice(
            0,
            8
        );


    const time =
        new Date(
            event.created_at *
            1000
        ).toLocaleTimeString(
            'ar-EG',
            {
                hour:
                    '2-digit',

                minute:
                    '2-digit'
            }
        );


    const state = {

        id:
            event.id,

        pubkey:
            event.pubkey,

        likes:
            0,

        replies:
            0,

        liked:
            false
    };


    postState.set(
        event.id,
        state
    );


    const div =
        document.createElement(
            'div'
        );


    div.className =
        'post-card bg-white dark:bg-surface rounded-2xl p-4 shadow-sm border border-gray-100 dark:border-gray-800 fade-in';


    div.dataset.postId =
        event.id;


    div.innerHTML = `

        <div class="flex justify-between items-start mb-3">

            <div class="flex items-center gap-3">

                <div
                    class="avatar w-10 h-10 bg-indigo-500 text-sm"
                >
                    ${escapeHtml(shortPubkey)}
                </div>

                <div>

                    <div
                        class="font-bold text-sm dark:text-white"
                    >
                        ${escapeHtml(shortPubkey)}...
                    </div>

                    <div
                        class="text-xs text-gray-400"
                    >
                        ${time}
                    </div>

                </div>

            </div>

        </div>


        <p
            class="text-gray-800 dark:text-gray-200 leading-relaxed mb-4 whitespace-pre-wrap text-sm md:text-base"
        >
            ${escapeHtml(event.content)}
        </p>


        <div
            class="flex items-center gap-6 text-gray-400 text-sm border-t border-gray-100 dark:border-gray-800 pt-3"
        >

            <button
                id="like-btn-${event.id}"
                onclick="likePost('${event.id}', '${event.pubkey}')"
                class="like-button flex items-center gap-2 hover:text-red-500 transition"
            >

                <i class="far fa-heart"></i>

                <span>
                    إعجاب
                </span>

                <span
                    id="like-count-${event.id}"
                    class="text-xs"
                >
                    0
                </span>

            </button>


            <button
                onclick="replyToPost('${event.id}', '${event.pubkey}')"
                class="flex items-center gap-2 hover:text-blue-500 transition"
            >

                <i class="far fa-comment"></i>

                <span>
                    رد
                </span>

                <span
                    id="reply-count-${event.id}"
                    class="text-xs"
                >
                    0
                </span>

            </button>

        </div>

    `;


    container.prepend(
        div
    );
}


/* ============================================================
   نشر منشور
   ============================================================ */

async function publishPost() {

    const input =
        document.getElementById(
            'post-input'
        );


    if (!input) {
        return;
    }


    const content =
        input.value.trim();


    if (!content) {

        showToast(
            'اكتب شيئاً أولاً',
            'error'
        );

        return;
    }


    try {

        showToast(
            'جاري النشر...',
            'info'
        );


        const eventTemplate = {

            kind:
                1,

            created_at:
                Math.floor(
                    Date.now() /
                    1000
                ),

            tags: [
                [
                    't',
                    APP_TAG
                ]
            ],

            content:
                content
        };


        const result =
            await publishSignedEvent(
                eventTemplate
            );


        if (
            result.successCount >
            0
        ) {

            input.value =
                '';


            showToast(
                'تم النشر بنجاح',
                'success'
            );

        } else {

            showToast(
                'فشل النشر: لم يستجب أي Relay',
                'error'
            );
        }

    } catch (error) {

        console.error(
            '[Post] Publish Error:',
            error
        );

        showToast(
            'فشل النشر: ' +
            error.message,
            'error'
        );
    }
}


/* ============================================================
   Optimistic Like
   ============================================================ */

async function likePost(
    targetId,
    targetPubkey
) {

    const state =
        postState.get(
            targetId
        );


    const button =
        document.getElementById(
            `like-btn-${targetId}`
        );


    const count =
        document.getElementById(
            `like-count-${targetId}`
        );


    /*
     * لو ضغط المستخدم على نفس المنشور
     * أكثر من مرة أثناء الإرسال،
     * لا ننشر Events مكررة.
     */
    if (
        state &&
        state.liked
    ) {

        return;
    }


    /*
     * ========================================================
     * Optimistic UI
     *
     * نغير الواجهة قبل انتظار Relay.
     * ========================================================
     */

    if (state) {

        state.liked =
            true;

        state.likes +=
            1;
    }


    if (button) {

        button.classList.add(
            'liked'
        );

        button.classList.add(
            'like-pop'
        );


        const icon =
            button.querySelector(
                'i'
            );


        if (icon) {

            icon.className =
                'fas fa-heart text-red-500';
        }


        setTimeout(
            () =>
                button.classList.remove(
                    'like-pop'
                ),
            300
        );
    }


    updatePostCounters(
        targetId
    );


    try {

        const eventTemplate = {

            kind:
                7,

            created_at:
                Math.floor(
                    Date.now() /
                    1000
                ),

            tags: [
                [
                    'e',
                    targetId,
                    '',
                    'root'
                ],

                [
                    'p',
                    targetPubkey
                ]
            ],

            content:
                '+'
        };


        const result =
            await publishSignedEvent(
                eventTemplate
            );


        if (
            result.successCount >
            0
        ) {

            showToast(
                'تم الإعجاب',
                'success'
            );

        } else {

            /*
             * لو لم يصل الحدث لأي Relay،
             * نرجع Optimistic UI.
             */
            rollbackLike(
                targetId
            );


            showToast(
                'تعذر تأكيد الإعجاب من الشبكة',
                'error'
            );
        }

    } catch (error) {

        console.error(
            '[Like] Error:',
            error
        );


        rollbackLike(
            targetId
        );


        showToast(
            'فشل الإعجاب: ' +
            error.message,
            'error'
        );
    }
}


/* ============================================================
   Rollback Like
   ============================================================ */

function rollbackLike(
    targetId
) {

    const state =
        postState.get(
            targetId
        );


    if (!state) {
        return;
    }


    if (
        state.liked
    ) {

        state.liked =
            false;

        state.likes =
            Math.max(
                0,
                state.likes - 1
            );
    }


    const button =
        document.getElementById(
            `like-btn-${targetId}`
        );


    if (button) {

        button.classList.remove(
            'liked'
        );


        const icon =
            button.querySelector(
                'i'
            );


        if (icon) {

            icon.className =
                'far fa-heart';
        }
    }


    updatePostCounters(
        targetId
    );
}


/* ============================================================
   رد
   ============================================================ */

async function replyToPost(
    targetId,
    targetPubkey
) {

    const content =
        prompt(
            'اكتب ردك:'
        );


    if (
        !content ||
        !content.trim()
    ) {
        return;
    }


    try {

        const eventTemplate = {

            kind:
                1,

            created_at:
                Math.floor(
                    Date.now() /
                    1000
                ),

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

            content:
                content.trim()
        };


        const result =
            await publishSignedEvent(
                eventTemplate
            );


        if (
            result.successCount >
            0
        ) {

            showToast(
                'تم إرسال الرد',
                'success'
            );

        } else {

            showToast(
                'تعذر نشر الرد',
                'error'
            );
        }

    } catch (error) {

        console.error(
            '[Reply] Error:',
            error
        );


        showToast(
            'فشل إرسال الرد: ' +
            error.message,
            'error'
        );
    }
}


/* ============================================================
   Real-Time Interactions
   ============================================================ */

function refreshInteractionSubscription() {

    if (
        interactionSubscription
    ) {

        try {
            interactionSubscription.close();
        } catch (_) {}

        interactionSubscription =
            null;
    }


    const postIds =
        Array.from(
            document.querySelectorAll(
                '.post-card[data-post-id]'
            )
        )
            .map(
                element =>
                    element.dataset.postId
            )
            .filter(Boolean);


    if (!postIds.length) {
        return;
    }


    /*
     * Nostr لا يسمح بفلتر e متعدد في
     * بعض البيئات بنفس طريقة الاستعلام التقليدية،
     * لذلك ننشئ فلتر لكل المنشورات الحالية.
     */
    const filters =
        postIds.map(
            id => ({
                kinds: [7],
                '#e': [id],
                limit: 100
            })
        );


    /*
     * نضيف فلتر منفصل للردود.
     */
    postIds.forEach(
        id => {

            filters.push({

                kinds: [1],

                '#e': [id],

                limit: 100
            });
        }
    );


    console.log(
        '[Interactions] مراقبة:',
        postIds.length,
        'منشور'
    );


    interactionSubscription =
        pool.subscribeMany(
            RELAYS,
            filters,
            {

                onevent(event) {

                    handleInteractionEvent(
                        event
                    );
                },


                oneose() {

                    console.log(
                        '[Interactions] انتهى تحميل التفاعلات الحالية.'
                    );
                },


                onclose(reason) {

                    console.warn(
                        '[Interactions] تم إغلاق الاشتراك:',
                        reason
                    );
                }
            }
        );
}


/* ============================================================
   معالجة التفاعل
   ============================================================ */

function handleInteractionEvent(
    event
) {

    if (!event) {
        return;
    }


    /*
     * معرفة المنشور المستهدف.
     */
    const targetId =
        getTargetPostId(
            event
        );


    if (!targetId) {
        return;
    }


    const state =
        postState.get(
            targetId
        );


    if (!state) {
        return;
    }


    if (
        event.kind === 7
    ) {

        /*
         * منع احتساب نفس Event مرتين.
         */
        if (
            state.likeEvents &&
            state.likeEvents.has(
                event.id
            )
        ) {
            return;
        }


        if (!state.likeEvents) {

            state.likeEvents =
                new Set();
        }


        state.likeEvents.add(
            event.id
        );


        /*
         * إذا كان إعجاب المستخدم نفسه،
         * Optimistic UI قد سبق واحتسبه.
         */
        const isOwnLike =
            event.pubkey ===
            pk;


        if (
            !isOwnLike ||
            !state.liked
        ) {

            state.likes +=
                1;
        }


        updatePostCounters(
            targetId
        );
    }


    /*
     * الردود.
     */
    if (
        event.kind === 1
    ) {

        if (
            state.replyEvents &&
            state.replyEvents.has(
                event.id
            )
        ) {
            return;
        }


        if (!state.replyEvents) {

            state.replyEvents =
                new Set();
        }


        state.replyEvents.add(
            event.id
        );


        state.replies +=
            1;


        updatePostCounters(
            targetId
        );
    }
}


/* ============================================================
   معرفة المنشور المستهدف
   ============================================================ */

function getTargetPostId(
    event
) {

    if (
        !event.tags
    ) {
        return null;
    }


    const tag =
        event.tags.find(
            item =>
                Array.isArray(item) &&
                item[0] === 'e' &&
                item[1]
        );


    return tag
        ? tag[1]
        : null;
}


/* ============================================================
   تحديث العدادات
   ============================================================ */

function updatePostCounters(
    postId
) {

    const state =
        postState.get(
            postId
        );


    if (!state) {
        return;
    }


    const likeCount =
        document.getElementById(
            `like-count-${postId}`
        );


    const replyCount =
        document.getElementById(
            `reply-count-${postId}`
        );


    if (likeCount) {

        likeCount.textContent =
            formatNumber(
                state.likes
            );
    }


    if (replyCount) {

        replyCount.textContent =
            formatNumber(
                state.replies
            );
    }
}


/* ============================================================
   تنسيق الأرقام
   ============================================================ */

function formatNumber(
    number
) {

    if (
        number < 1000
    ) {
        return String(
            number
        );
    }


    if (
        number < 1000000
    ) {

        return (
            number / 1000
        )
            .toFixed(1)
            .replace(
                '.0',
                ''
            ) +
            'K';
    }


    return (
        number / 1000000
    )
        .toFixed(1)
        .replace(
            '.0',
            ''
        ) +
        'M';
}


/* ============================================================
   Voice Rooms
   ============================================================ */


/*
 * تطبيع اسم الغرفة.
 */
function normalizeRoomName(
    roomName
) {

    return String(
        roomName || ''
    )
        .trim()
        .toLowerCase()
        .replace(
            /\s+/g,
            '-'
        )
        .replace(
            /[^\p{L}\p{N}\-_]/gu,
            ''
        )
        .slice(
            0,
            50
        );
}


/*
 * إنشاء حالة غرفة.
 */
function ensureRoom(
    roomName
) {

    const normalized =
        normalizeRoomName(
            roomName
        );


    if (!normalized) {
        return null;
    }


    if (
        !roomsState.rooms.has(
            normalized
        )
    ) {

        roomsState.rooms.set(
            normalized,
            {
                name:
                    normalized,

                participants:
                    new Map(),

                lastActivity:
                    Date.now()
            }
        );
    }


    return roomsState.rooms.get(
        normalized
    );
}


/* ============================================================
   اكتشاف الغرف
   ============================================================ */

function startRoomsDirectory() {

    if (
        roomsState.subscription
    ) {

        try {
            roomsState.subscription.close();
        } catch (_) {}

        roomsState.subscription =
            null;
    }


    console.log(
        '[Rooms] بدء اكتشاف الغرف...'
    );


    const loading =
        document.getElementById(
            'rooms-loading'
        );


    if (loading) {

        loading.classList.remove(
            'hidden'
        );
    }


    /*
     * نراقب Events الخاصة بالـPresence فقط.
     *
     * #t يسمح للـRelay بفهرسة الحدث.
     */
    roomsState.subscription =
        pool.subscribeMany(
            RELAYS,
            [
                {
                    kinds: [1],

                    '#t': [
                        ROOM_PRESENCE_TAG
                    ],

                    limit: 500
                }
            ],
            {

                onevent(event) {

                    handleRoomPresenceEvent(
                        event
                    );
                },


                oneose() {

                    if (loading) {

                        loading.classList.add(
                            'hidden'
                        );
                    }


                    cleanupExpiredRooms();

                    renderRoomsDirectory();


                    console.log(
                        '[Rooms] انتهى اكتشاف الغرف الحالية.'
                    );
                },


                onclose(reason) {

                    console.warn(
                        '[Rooms] تم إغلاق اشتراك الغرف:',
                        reason
                    );
                }
            }
        );
}


/* ============================================================
   معالجة Presence
   ============================================================ */

function handleRoomPresenceEvent(
    event
) {

    if (
        !event ||
        !event.id ||
        !event.pubkey
    ) {
        return;
    }


    /*
     * التأكد أن الحدث يحتوي على Tag الصحيح.
     */
    const isRoomPresence =
        event.tags &&
        event.tags.some(
            tag =>
                Array.isArray(tag) &&
                tag[0] === 't' &&
                tag[1] ===
                    ROOM_PRESENCE_TAG
        );


    if (!isRoomPresence) {
        return;
    }


    let data;


    try {

        data =
            JSON.parse(
                event.content
            );

    } catch (_) {

        console.warn(
            '[Rooms] Presence غير صالح:',
            event.id
        );

        return;
    }


    if (
        !data ||
        !data.peerId ||
        !data.room
    ) {
        return;
    }


    const roomName =
        normalizeRoomName(
            data.room
        );


    if (!roomName) {
        return;
    }


    const room =
        ensureRoom(
            roomName
        );


    if (!room) {
        return;
    }


    const timestamp =
        Number(
            data.timestamp
        ) ||
        event.created_at *
            1000;


    room.participants.set(
        event.pubkey,
        {

            pubkey:
                event.pubkey,

            peerId:
                String(
                    data.peerId
                ),

            npub:
                data.npub ||
                event.pubkey.slice(
                    0,
                    8
                ),

            displayName:
                data.displayName ||
                data.npub ||
                event.pubkey.slice(
                    0,
                    8
                ),

            lastSeen:
                timestamp
        }
    );


    room.lastActivity =
        Math.max(
            room.lastActivity,
            timestamp
        );


    /*
     * لو نحن داخل نفس الغرفة،
     * نحدث قائمة المشاركين.
     */
    if (
        currentRoom ===
        roomName
    ) {

        updateActiveRoomParticipants(
            room
        );
    }


    renderRoomsDirectory();
}


/* ============================================================
   تنظيف Presence القديم
   ============================================================ */

function cleanupExpiredRooms() {

    const now =
        Date.now();


    for (
        const [
            roomName,
            room
        ]
        of roomsState.rooms
    ) {

        for (
            const [
                pubkey,
                participant
            ]
            of room.participants
        ) {

            if (
                now -
                participant.lastSeen >
                ROOM_PRESENCE_TTL
            ) {

                room.participants.delete(
                    pubkey
                );
            }
        }


        /*
         * الغرفة تختفي إذا لم يبق فيها أحد.
         */
        if (
            room.participants.size ===
            0
        ) {

            roomsState.rooms.delete(
                roomName
            );
        }
    }


    if (
        currentRoom
    ) {

        const current =
            roomsState.rooms.get(
                currentRoom
            );


        if (current) {

            updateActiveRoomParticipants(
                current
            );
        }
    }


    renderRoomsDirectory();
}


/* ============================================================
   تشغيل تنظيف الغرف
   ============================================================ */

function startRoomsCleanup() {

    if (
        roomsState.cleanupTimer
    ) {

        clearInterval(
            roomsState.cleanupTimer
        );
    }


    roomsState.cleanupTimer =
        setInterval(
            cleanupExpiredRooms,
            5000
        );
}


/* ============================================================
   رسم Directory
   ============================================================ */

function renderRoomsDirectory() {

    const container =
        document.getElementById(
            'rooms-list'
        );


    if (!container) {
        return;
    }


    const rooms =
        Array
            .from(
                roomsState.rooms.values()
            )
            .filter(
                room =>
                    room.participants.size >
                    0
            )
            .sort(
                (a, b) =>
                    b.lastActivity -
                    a.lastActivity
            );


    if (!rooms.length) {

        container.innerHTML = `

            <div
                class="text-center py-10"
            >

                <div
                    class="w-16 h-16 rounded-full bg-accent/10 flex items-center justify-center mx-auto mb-4"
                >
                    <i
                        class="fas fa-microphone-slash text-accent text-2xl"
                    ></i>
                </div>

                <h4
                    class="font-bold dark:text-white"
                >
                    لا توجد غرف مباشرة الآن
                </h4>

                <p
                    class="text-sm text-gray-400 mt-2"
                >
                    كن أول من ينشئ غرفة!
                </p>

            </div>

        `;

        return;
    }


    container.innerHTML =
        rooms
            .map(
                renderRoomCard
            )
            .join('');
}


/* ============================================================
   Room Card
   ============================================================ */

function renderRoomCard(
    room
) {

    const participants =
        Array
            .from(
                room.participants.values()
            )
            .sort(
                (a, b) =>
                    b.lastSeen -
                    a.lastSeen
            );


    const firstParticipants =
        participants.slice(
            0,
            4
        );


    const remaining =
        Math.max(
            0,
            participants.length -
                firstParticipants.length
        );


    const avatars =
        firstParticipants
            .map(
                participant => `

                    <div
                        class="w-9 h-9 rounded-full bg-indigo-500 text-white flex items-center justify-center text-[9px] font-bold border-2 border-white dark:border-surface"
                        title="${escapeAttribute(
                            participant.displayName
                        )}"
                    >
                        ${escapeHtml(
                            participant.npub.slice(
                                0,
                                5
                            )
                        )}
                    </div>

                `
            )
            .join('');


    const safeRoom =
        escapeAttribute(
            room.name
        );


    return `

        <div
            class="room-card rounded-2xl border border-gray-100 dark:border-gray-800 p-4 hover:border-accent/40 hover:shadow-md"
        >

            <div
                class="flex items-center justify-between gap-4"
            >

                <div
                    class="flex items-center gap-3 min-w-0"
                >

                    <div
                        class="relative flex-shrink-0"
                    >

                        <div
                            class="w-12 h-12 rounded-2xl bg-accent/10 flex items-center justify-center"
                        >
                            <i
                                class="fas fa-microphone text-accent"
                            ></i>
                        </div>

                        <span
                            class="absolute -top-1 -right-1 w-3 h-3 rounded-full bg-green-500 border-2 border-white dark:border-surface animate-pulse"
                        ></span>

                    </div>


                    <div
                        class="min-w-0"
                    >

                        <h4
                            class="font-black text-base dark:text-white truncate"
                        >
                            ${escapeHtml(
                                room.name
                            )}
                        </h4>

                        <div
                            class="flex items-center gap-2 mt-1 text-xs text-gray-400"
                        >

                            <i
                                class="fas fa-users"
                            ></i>

                            <span>
                                ${room.participants.size}
                                ${
                                    room.participants.size === 1
                                        ? 'مشارك'
                                        : 'مشاركين'
                                }
                            </span>

                            <span>
                                •
                            </span>

                            <span>
                                مباشر الآن
                            </span>

                        </div>

                    </div>

                </div>


                <button
                    onclick="joinRoomByName('${safeRoom}')"
                    class="flex-shrink-0 bg-accent text-white font-bold px-5 py-2.5 rounded-xl hover:bg-orange-600 transition active:scale-95 shadow-sm"
                >
                    دخول
                </button>

            </div>


            <div
                class="flex items-center mt-4"
            >

                <div
                    class="flex -space-x-2 space-x-reverse"
                >

                    ${avatars}

                    ${
                        remaining > 0
                            ? `
                                <div
                                    class="w-9 h-9 rounded-full bg-gray-100 dark:bg-gray-800 text-gray-500 dark:text-gray-300 flex items-center justify-center text-xs font-bold border-2 border-white dark:border-surface"
                                >
                                    +${remaining}
                                </div>
                            `
                            : ''
                    }

                </div>

            </div>

        </div>

    `;
}


/* ============================================================
   إنشاء غرفة والدخول
   ============================================================ */

function createAndJoinRoom() {

    const input =
        document.getElementById(
            'room-input'
        );


    if (!input) {
        return;
    }


    const roomName =
        normalizeRoomName(
            input.value
        );


    if (!roomName) {

        showToast(
            'اكتب اسم الغرفة أولاً',
            'error'
        );

        input.focus();

        return;
    }


    input.value =
        roomName;


    toggleRoom();
}


/* ============================================================
   دخول غرفة من القائمة
   ============================================================ */

function joinRoomByName(
    roomName
) {

    const normalized =
        normalizeRoomName(
            roomName
        );


    if (!normalized) {
        return;
    }


    const input =
        document.getElementById(
            'room-input'
        );


    if (input) {

        input.value =
            normalized;
    }


    toggleRoom();
}


/* ============================================================
   Presence
   ============================================================ */

async function announcePresence(
    myPeerId
) {

    if (
        !currentRoom ||
        !myPeerId ||
        !secretKeyHex
    ) {
        return;
    }


    const eventTemplate = {

        kind:
            1,

        created_at:
            Math.floor(
                Date.now() /
                1000
            ),

        tags: [

            [
                't',
                ROOM_TAG
            ],

            [
                't',
                ROOM_PRESENCE_TAG
            ],

            [
                'room',
                currentRoom
            ],

            [
                'type',
                'voice-presence'
            ]

        ],

        content:
            JSON.stringify({

                version:
                    1,

                room:
                    currentRoom,

                peerId:
                    myPeerId,

                npub:
                    npub
                        ? npub.slice(
                            0,
                            12
                        )
                        : '',

                displayName:
                    npub
                        ? npub.slice(
                            0,
                            8
                        )
                        : 'مستخدم',

                timestamp:
                    Date.now()

            })
    };


    try {

        const result =
            await publishSignedEvent(
                eventTemplate
            );


        if (
            result.successCount ===
            0
        ) {

            console.warn(
                '[Rooms] لم يؤكد أي Relay نشر Presence.'
            );
        }

    } catch (error) {

        console.error(
            '[Rooms] Presence Error:',
            error
        );
    }
}


/* ============================================================
   Heartbeat
   ============================================================ */

function startRoomHeartbeat(
    myPeerId
) {

    stopRoomHeartbeat();


    /*
     * Presence أولي فوراً.
     */
    announcePresence(
        myPeerId
    );


    /*
     * تجديد Presence كل 20 ثانية.
     */
    roomsState.heartbeatTimer =
        setInterval(
            () => {

                if (
                    currentRoom &&
                    peer &&
                    peer.id
                ) {

                    announcePresence(
                        peer.id
                    );
                }

            },
            ROOM_HEARTBEAT_INTERVAL
        );
}


function stopRoomHeartbeat() {

    if (
        roomsState.heartbeatTimer
    ) {

        clearInterval(
            roomsState.heartbeatTimer
        );

        roomsState.heartbeatTimer =
            null;
    }
}


/* ============================================================
   دخول / خروج الغرفة
   ============================================================ */

async function toggleRoom(
    forceLeave = false
) {

    const btn =
        document.getElementById(
            'btn-join-room'
        );


    const input =
        document.getElementById(
            'room-input'
        );


    const activeUi =
        document.getElementById(
            'active-room-ui'
        );


    /*
     * إذا كنا داخل غرفة:
     * الزر يعني مغادرة.
     */
    if (
        currentRoom &&
        !forceLeave
    ) {

        leaveRoom();

        return;
    }


    /*
     * دخول غرفة.
     */
    if (!currentRoom) {

        const requestedRoom =
            normalizeRoomName(
                input
                    ? input.value
                    : ''
            );


        if (!requestedRoom) {

            showToast(
                'اختر غرفة أو اكتب اسم غرفة جديدة',
                'error'
            );

            return;
        }


        currentRoom =
            requestedRoom;
    }


    try {

        /*
         * ====================================================
         * 1. طلب الميكروفون
         * ====================================================
         */

        if (
            !navigator.mediaDevices ||
            !navigator.mediaDevices.getUserMedia
        ) {

            throw new Error(
                'المتصفح لا يدعم الوصول إلى الميكروفون'
            );
        }


        showToast(
            'جاري تشغيل الميكروفون...',
            'info'
        );


        localStream =
            await navigator.mediaDevices.getUserMedia({

                audio: {

                    echoCancellation:
                        true,

                    noiseSuppression:
                        true,

                    autoGainControl:
                        true
                }

            });


        console.log(
            '[WebRTC] الميكروفون يعمل.'
        );


        /*
         * ====================================================
         * 2. إنشاء PeerJS
         * ====================================================
         */

        const peerConfig = {

            host:
                '0.peerjs.com',

            port:
                443,

            secure:
                true,

            debug:
                2,


            /*
             * ICE Servers:
             *
             * Google STUN يساعد في اكتشاف الـPublic Address.
             *
             * PeerJS يستخدم signaling server الخاص به.
             *
             * TURN حقيقي يمكن إضافته لاحقاً.
             */
            config: {

                iceServers: [

                    {
                        urls:
                            'stun:stun.l.google.com:19302'
                    },

                    {
                        urls:
                            'stun:stun1.l.google.com:19302'
                    },

                    {
                        urls:
                            'stun:stun2.l.google.com:19302'
                    },

                    {
                        urls:
                            'stun:stun3.l.google.com:19302'
                    },

                    {
                        urls:
                            'stun:stun4.l.google.com:19302'
                    }

                ],

                iceTransportPolicy:
                    'all'
            }
        };


        /*
         * لا نعطي Peer ID يدوياً.
         *
         * PeerJS سيولد ID فريد من السيرفر.
         */
        peer =
            new Peer(
                peerConfig
            );


        registerPeerEvents();


        /*
         * ====================================================
         * UI
         * ====================================================
         */

        const roomNameElement =
            document.getElementById(
                'current-room-name'
            );


        if (roomNameElement) {

            roomNameElement.textContent =
                `غرفة: ${currentRoom}`;
        }


        const status =
            document.getElementById(
                'room-connection-status'
            );


        if (status) {

            status.textContent =
                'جاري الاتصال بشبكة الصوت...';
        }


        activeUi.classList.remove(
            'hidden'
        );


        btn.textContent =
            'مغادرة';


        btn.classList.remove(
            'bg-white',
            'text-accent'
        );


        btn.classList.add(
            'bg-red-500',
            'text-white'
        );


        input.disabled =
            true;


        localStorage.setItem(
            'active_room',
            currentRoom
        );


        console.log(
            '[Rooms] بدء الدخول إلى:',
            currentRoom
        );


    } catch (error) {

        console.error(
            '[Rooms] Room Init Error:',
            error
        );


        cleanupLocalMedia();


        if (peer) {

            try {
                peer.destroy();
            } catch (_) {}

            peer =
                null;
        }


        const errorMessage =
            getMediaErrorMessage(
                error
            );


        showToast(
            errorMessage,
            'error'
        );


        currentRoom =
            null;


        localStorage.removeItem(
            'active_room'
        );
    }
}


/* ============================================================
   تسجيل أحداث PeerJS
   ============================================================ */

function registerPeerEvents() {

    if (!peer) {
        return;
    }


    /*
     * Peer ID جاهز.
     */
    peer.on(
        'open',
        id => {

            console.log(
                '[PeerJS] الاتصال بالسيرفر نجح.',
                id
            );


            const status =
                document.getElementById(
                    'room-connection-status'
                );


            if (status) {

                status.textContent =
                    'أنت متصل الآن. المايكروفون نشط.';
            }


            /*
             * إعلان وجودنا.
             */
            startRoomHeartbeat(
                id
            );


            /*
             * الاستماع إلى الموجودين.
             */
            listenForPeers();
        }
    );


    /*
     * Incoming Call
     */
    peer.on(
        'call',
        call => {

            console.log(
                '[WebRTC] اتصال صوتي وارد من:',
                call.peer
            );


            if (
                !localStream
            ) {

                console.error(
                    '[WebRTC] لا يوجد Local Stream للرد على الاتصال.'
                );

                call.close();

                return;
            }


            try {

                call.answer(
                    localStream
                );

            } catch (error) {

                console.error(
                    '[WebRTC] فشل الرد على الاتصال:',
                    error
                );

                return;
            }


            registerCall(
                call,
                call.peer,
                'مشارك'
            );
        }
    );


    /*
     * PeerJS Error
     */
    peer.on(
        'error',
        error => {

            console.error(
                '[PeerJS] Error:',
                error
            );


            handlePeerError(
                error
            );
        }
    );


    /*
     * Disconnected
     */
    peer.on(
        'disconnected',
        () => {

            console.warn(
                '[PeerJS] تم فصل الاتصال بالسيرفر.'
            );


            const status =
                document.getElementById(
                    'room-connection-status'
                );


            if (status) {

                status.textContent =
                    'انقطع الاتصال بخادم الإشارة...';
            }
        }
    );


    /*
     * Close
     */
    peer.on(
        'close',
        () => {

            console.log(
                '[PeerJS] Peer مغلق.'
            );
        }
    );
}


/* ============================================================
   Peer Error Handler
   ============================================================ */

function handlePeerError(
    error
) {

    const type =
        error &&
        error.type
            ? error.type
            : 'unknown';


    let message;


    switch (type) {

        case 'peer-unavailable':

            message =
                'المشارك غير متاح حالياً أو غادر الغرفة.';

            break;


        case 'network':

            message =
                'مشكلة في الشبكة أو خادم الإشارة. تحقق من الإنترنت.';

            break;


        case 'server-error':

            message =
                'خادم PeerJS رفض الاتصال. حاول مرة أخرى.';

            break;


        case 'socket-error':

            message =
                'تعذر فتح اتصال الإشارة مع PeerJS.';

            break;


        case 'socket-closed':

            message =
                'تم إغلاق اتصال الإشارة مع PeerJS.';

            break;


        case 'unavailable-id':

            message =
                'معرف PeerJS غير متاح. أعد المحاولة.';

            break;


        case 'invalid-id':

            message =
                'معرف PeerJS غير صالح.';

            break;


        case 'webrtc':

            message =
                'المتصفح فشل في إنشاء اتصال WebRTC.';

            break;


        default:

            message =
                'فشل اتصال الصوت: ' +
                (
                    error.message ||
                    type
                );
    }


    showToast(
        message,
        'error'
    );
}


/* ============================================================
   Nostr Signaling للغرفة الحالية
   ============================================================ */

function listenForPeers() {

    if (
        !currentRoom
    ) {
        return;
    }


    if (
        roomSub
    ) {

        try {
            roomSub.close();
        } catch (_) {}

        roomSub =
            null;
    }


    console.log(
        '[Rooms] الاستماع إلى المشاركين في:',
        currentRoom
    );


    roomSub =
        pool.subscribeMany(
            RELAYS,
            [
                {

                    kinds: [1],

                    '#t': [
                        ROOM_TAG
                    ],

                    '#room': [
                        currentRoom
                    ],

                    limit:
                        100
                }
            ],
            {

                onevent(event) {

                    if (
                        event.pubkey ===
                        pk
                    ) {
                        return;
                    }


                    /*
                     * نتحقق أن هذا Presence
                     * وليس منشوراً آخر.
                     */
                    const isPresence =
                        event.tags &&
                        event.tags.some(
                            tag =>
                                Array.isArray(tag) &&
                                tag[0] === 't' &&
                                tag[1] ===
                                    ROOM_PRESENCE_TAG
                        );


                    if (!isPresence) {
                        return;
                    }


                    let data;


                    try {

                        data =
                            JSON.parse(
                                event.content
                            );

                    } catch (_) {

                        return;
                    }


                    if (
                        !data ||
                        !data.peerId
                    ) {
                        return;
                    }


                    /*
                     * لا نتصل بأنفسنا.
                     */
                    if (
                        peer &&
                        data.peerId ===
                            peer.id
                    ) {
                        return;
                    }


                    /*
                     * لو الاتصال موجود بالفعل،
                     * لا نعيد الاتصال.
                     */
                    if (
                        activeCalls.has(
                            data.peerId
                        )
                    ) {
                        return;
                    }


                    console.log(
                        '[WebRTC] محاولة الاتصال بـ:',
                        data.peerId
                    );


                    connectToPeer(
                        data.peerId,
                        data.displayName ||
                        data.npub ||
                        'مشارك'
                    );
                },


                oneose() {

                    console.log(
                        '[Rooms] تم تحميل المشاركين الحاليين.'
                    );
                },


                onclose(reason) {

                    console.warn(
                        '[Rooms] Signaling closed:',
                        reason
                    );
                }
            }
        );
}


/* ============================================================
   الاتصال بـ Peer
   ============================================================ */

function connectToPeer(
    targetPeerId,
    displayName
) {

    if (
        !peer ||
        peer.destroyed ||
        !localStream
    ) {

        console.warn(
            '[WebRTC] محاولة اتصال بدون Peer أو Mic.'
        );

        return;
    }


    if (
        targetPeerId ===
        peer.id
    ) {
        return;
    }


    if (
        activeCalls.has(
            targetPeerId
        )
    ) {
        return;
    }


    try {

        const call =
            peer.call(
                targetPeerId,
                localStream,
                {
                    metadata: {
                        room:
                            currentRoom
                    }
                }
            );


        if (!call) {

            console.error(
                '[WebRTC] peer.call أعاد null.'
            );

            return;
        }


        registerCall(
            call,
            targetPeerId,
            displayName
        );


    } catch (error) {

        console.error(
            '[WebRTC] فشل إنشاء الاتصال:',
            targetPeerId,
            error
        );


        showToast(
            'تعذر الاتصال بأحد المشاركين',
            'error'
        );
    }
}


/* ============================================================
   تسجيل Call
   ============================================================ */

function registerCall(
    call,
    peerId,
    displayName
) {

    if (
        activeCalls.has(
            peerId
        )
    ) {

        try {
            call.close();
        } catch (_) {}

        return;
    }


    activeCalls.set(
        peerId,
        call
    );


    call.__displayName =
        displayName ||
        'مشارك';


    call.on(
        'stream',
        remoteStream => {

            console.log(
                '[WebRTC] استقبلنا صوتاً من:',
                peerId
            );


            addPeerAudio(
                remoteStream,
                call.__displayName,
                peerId
            );
        }
    );


    call.on(
        'close',
        () => {

            console.log(
                '[WebRTC] انتهى اتصال:',
                peerId
            );


            removePeerAudio(
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


            removePeerAudio(
                peerId
            );
        }
    );
}


/* ============================================================
   إضافة الصوت
   ============================================================ */

function addPeerAudio(
    stream,
    name,
    peerId
) {

    if (
        !stream ||
        !peerId
    ) {
        return;
    }


    /*
     * منع إنشاء Audio مكرر.
     */
    const existing =
        document.getElementById(
            `audio-${peerId}`
        );


    if (existing) {

        existing.srcObject =
            stream;

        return;
    }


    remoteStreams.set(
        peerId,
        stream
    );


    const audio =
        document.createElement(
            'audio'
        );


    audio.id =
        `audio-${peerId}`;


    audio.srcObject =
        stream;


    audio.autoplay =
        true;


    audio.playsInline =
        true;


    audio.setAttribute(
        'data-peer-audio',
        peerId
    );


    /*
     * بعض المتصفحات تحتاج play()
     * بشكل صريح بعد استلام الـStream.
     */
    audio.play()
        .catch(
            error => {

                console.warn(
                    '[WebRTC] تعذر تشغيل الصوت تلقائياً:',
                    error
                );


                showToast(
                    'تم الاتصال، اضغط على الصفحة لتشغيل صوت المشارك',
                    'info'
                );
            }
        );


    document.body.appendChild(
        audio
    );


    addPeerParticipant(
        peerId,
        name
    );
}


/* ============================================================
   إضافة مشارك للواجهة
   ============================================================ */

function addPeerParticipant(
    peerId,
    name
) {

    const container =
        document.getElementById(
            'peers-list'
        );


    if (!container) {
        return;
    }


    if (
        document.getElementById(
            `peer-${peerId}`
        )
    ) {
        return;
    }


    const div =
        document.createElement(
            'div'
        );


    div.id =
        `peer-${peerId}`;


    div.className =
        'flex items-center justify-between gap-2 bg-gray-50 dark:bg-gray-800 p-3 rounded-lg';


    div.innerHTML = `

        <div
            class="flex items-center gap-2 min-w-0"
        >

            <div
                class="w-2 h-2 bg-green-500 rounded-full animate-pulse flex-shrink-0"
            ></div>

            <span
                class="truncate"
            >
                ${escapeHtml(
                    name ||
                    'مشارك'
                )}
            </span>

        </div>

        <i
            class="fas fa-microphone text-green-500 text-xs"
        ></i>

    `;


    container.appendChild(
        div
    );
}


/* ============================================================
   حذف مشارك
   ============================================================ */

function removePeerAudio(
    peerId
) {

    activeCalls.delete(
        peerId
    );


    remoteStreams.delete(
        peerId
    );


    const audio =
        document.getElementById(
            `audio-${peerId}`
        );


    if (audio) {

        audio.pause();

        audio.srcObject =
            null;

        audio.remove();
    }


    const participant =
        document.getElementById(
            `peer-${peerId}`
        );


    if (participant) {

        participant.remove();
    }
}


/* ============================================================
   مغادرة الغرفة
   ============================================================ */

function leaveRoom() {

    console.log(
        '[Rooms] مغادرة الغرفة:',
        currentRoom
    );


    stopRoomHeartbeat();


    if (
        roomSub
    ) {

        try {
            roomSub.close();
        } catch (_) {}

        roomSub =
            null;
    }


    /*
     * إغلاق جميع الاتصالات.
     */
    for (
        const call
        of activeCalls.values()
    ) {

        try {
            call.close();
        } catch (_) {}
    }


    activeCalls.clear();


    remoteStreams.clear();


    /*
     * إيقاف PeerJS.
     */
    if (peer) {

        try {
            peer.destroy();
        } catch (error) {

            console.warn(
                '[PeerJS] Destroy Error:',
                error
            );
        }

        peer =
            null;
    }


    cleanupLocalMedia();


    currentRoom =
        null;


    localStorage.removeItem(
        'active_room'
    );


    const activeUi =
        document.getElementById(
            'active-room-ui'
        );


    if (activeUi) {

        activeUi.classList.add(
            'hidden'
        );
    }


    const peersList =
        document.getElementById(
            'peers-list'
        );


    if (peersList) {

        peersList.innerHTML =
            '';
    }


    const btn =
        document.getElementById(
            'btn-join-room'
        );


    if (btn) {

        btn.textContent =
            'إنشاء';

        btn.classList.remove(
            'bg-red-500',
            'text-white'
        );

        btn.classList.add(
            'bg-white',
            'text-accent'
        );
    }


    const input =
        document.getElementById(
            'room-input'
        );


    if (input) {

        input.disabled =
            false;
    }


    renderRoomsDirectory();


    showToast(
        'غادرت الغرفة',
        'success'
    );
}


/* ============================================================
   تنظيف الميكروفون
   ============================================================ */

function cleanupLocalMedia() {

    if (
        localStream
    ) {

        localStream
            .getTracks()
            .forEach(
                track => {

                    try {
                        track.stop();
                    } catch (_) {}
                }
            );

        localStream =
            null;
    }


    isMuted =
        false;


    const muteButton =
        document.getElementById(
            'btn-mute'
        );


    if (muteButton) {

        muteButton.innerHTML =
            '<i class="fas fa-microphone"></i>';

        muteButton.classList.remove(
            'bg-red-100',
            'text-red-500'
        );
    }
}


/* ============================================================
   رسائل أخطاء Media
   ============================================================ */

function getMediaErrorMessage(
    error
) {

    if (!error) {

        return 'تعذر تشغيل الميكروفون.';
    }


    switch (
        error.name
    ) {

        case 'NotAllowedError':

        case 'PermissionDeniedError':

            return 'تم رفض صلاحية الميكروفون. اسمح للموقع باستخدام الميكروفون من إعدادات المتصفح.';


        case 'NotFoundError':

        case 'DevicesNotFoundError':

            return 'لم يتم العثور على ميكروفون متصل بالجهاز.';


        case 'NotReadableError':

        case 'TrackStartError':

            return 'الميكروفون مستخدم حالياً من تطبيق أو تبويب آخر.';


        case 'OverconstrainedError':

            return 'إعدادات الميكروفون غير متوافقة مع الجهاز.';


        case 'SecurityError':

            return 'المتصفح منع الوصول للميكروفون بسبب إعدادات الأمان.';


        default:

            return (
                'فشل تشغيل الميكروفون: ' +
                (
                    error.message ||
                    error.name ||
                    'خطأ غير معروف'
                )
            );
    }
}


/* ============================================================
   كتم الميكروفون
   ============================================================ */

function toggleMute() {

    if (
        !localStream
    ) {

        showToast(
            'الميكروفون غير متصل',
            'error'
        );

        return;
    }


    isMuted =
        !isMuted;


    localStream
        .getAudioTracks()
        .forEach(
            track => {

                track.enabled =
                    !isMuted;
            }
        );


    const btn =
        document.getElementById(
            'btn-mute'
        );


    if (!btn) {
        return;
    }


    btn.innerHTML =
        isMuted
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
        'info'
    );
}


/* ============================================================
   تحديث المشاركين في الغرفة الحالية
   ============================================================ */

function updateActiveRoomParticipants(
    room
) {

    if (
        !room ||
        currentRoom !==
            room.name
    ) {
        return;
    }


    const count =
        document.getElementById(
            'active-room-count'
        );


    if (count) {

        count.textContent =
            String(
                room.participants.size
            );
    }
}


/* ============================================================
   التنقل بين الصفحات
   ============================================================ */

function switchView(
    viewName
) {

    document
        .querySelectorAll(
            '.view-section'
        )
        .forEach(
            element =>
                element.classList.add(
                    'hidden'
                )
        );


    const target =
        document.getElementById(
            `view-${viewName}`
        );


    if (target) {

        target.classList.remove(
            'hidden'
        );
    }


    document
        .querySelectorAll(
            '.nav-btn'
        )
        .forEach(
            element => {

                element.classList.remove(
                    'text-accent',
                    'active'
                );

                element.classList.add(
                    'text-gray-400'
                );
            }
        );


    const activeButton =
        document.getElementById(
            `nav-${viewName}`
        );


    if (activeButton) {

        activeButton.classList.add(
            'text-accent',
            'active'
        );

        activeButton.classList.remove(
            'text-gray-400'
        );
    }


    /*
     * عند فتح الغرف، نعيد رسم القائمة.
     */
    if (
        viewName ===
        'rooms'
    ) {

        renderRoomsDirectory();
    }
}


/* ============================================================
   Dark Mode
   ============================================================ */

function toggleTheme() {

    document.documentElement
        .classList
        .toggle(
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


/* ============================================================
   Toast
   ============================================================ */

function showToast(
    msg,
    type = 'success'
) {

    const toast =
        document.getElementById(
            'toast'
        );


    const icon =
        document.getElementById(
            'toast-icon'
        );


    const message =
        document.getElementById(
            'toast-msg'
        );


    if (
        !toast ||
        !icon ||
        !message
    ) {
        return;
    }


    message.textContent =
        msg;


    if (
        type ===
        'error'
    ) {

        icon.className =
            'fas fa-exclamation-circle text-red-400';

    } else if (
        type ===
        'info'
    ) {

        icon.className =
            'fas fa-info-circle text-blue-400';

    } else {

        icon.className =
            'fas fa-check-circle text-green-400';
    }


    toast.classList.remove(
        'hidden'
    );


    clearTimeout(
        showToast.timeout
    );


    showToast.timeout =
        setTimeout(
            () => {

                toast.classList.add(
                    'hidden'
                );

            },
            3500
        );
}


/* ============================================================
   حماية HTML
   ============================================================ */

function escapeHtml(
    text
) {

    const div =
        document.createElement(
            'div'
        );


    div.textContent =
        text == null
            ? ''
            : String(text);


    return div.innerHTML;
}


/* ============================================================
   حماية Attribute
   ============================================================ */

function escapeAttribute(
    value
) {

    return String(
        value || ''
    )
        .replace(
            /\\/g,
            '\\\\'
        )
        .replace(
            /'/g,
            "\\'"
        )
        .replace(
            /"/g,
            '&quot;'
        )
        .replace(
            /</g,
            '&lt;'
        )
        .replace(
            />/g,
            '&gt;'
        );
}


/* ============================================================
   Boot Sequence
   ============================================================ */

document.addEventListener(
    'DOMContentLoaded',
    () => {

        /*
         * Theme
         */
        if (
            localStorage.getItem(
                'theme'
            ) === 'dark'
            ||
            (
                !localStorage.getItem(
                    'theme'
                )
                &&
                window.matchMedia(
                    '(prefers-color-scheme: dark)'
                ).matches
            )
        ) {

            document.documentElement
                .classList
                .add(
                    'dark'
                );
        }


        /*
         * Identity
         */
        initIdentity();


        /*
         * Feed
         */
        startFeed();


        /*
         * Live Rooms Directory
         */
        startRoomsDirectory();


        /*
         * تنظيف الغرف القديمة
         */
        startRoomsCleanup();


        /*
         * استعادة الغرفة السابقة.
         */
        const savedRoom =
            localStorage.getItem(
                'active_room'
            );


        if (savedRoom) {

            currentRoom =
                normalizeRoomName(
                    savedRoom
                );


            const input =
                document.getElementById(
                    'room-input'
                );


            if (input) {

                input.value =
                    currentRoom;
            }


            /*
             * لا ندخل تلقائياً للغرفة
             * إذا كان التطبيق أعيد تحميله.
             *
             * هذا يمنع تشغيل الميكروفون
             * بدون تفاعل المستخدم.
             */
            localStorage.removeItem(
                'active_room'
            );


            currentRoom =
                null;
        }
    }
);


/* ============================================================
   Service Worker
   ============================================================ */

if (
    'serviceWorker' in
    navigator
) {

    window.addEventListener(
        'load',
        () => {

            navigator.serviceWorker
                .register(
                    './sw.js'
                )

                .then(
                    () =>
                        console.log(
                            '[SW] تم تسجيل Service Worker'
                        )
                )

                .catch(
                    error =>
                        console.log(
                            '[SW] فشل التسجيل:',
                            error
                        )
                );
        }
    );
}
