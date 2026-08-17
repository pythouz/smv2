/* ============================================================
   Pulse — app.js
   Vanilla JS + Nostr + PeerJS/WebRTC
   ============================================================ */

/* ─────────────────────────────────────────────────────────────
   إعدادات عامة
   ───────────────────────────────────────────────────────────── */

const RELAYS = [
    'wss://relay.damus.io',
    'wss://relay.primal.net',
    'wss://nos.lol'
];

const APP_TAG = 'pulse-platform';
const ROOM_TAG = 'pulse-room';

const storageKey = 'pulse_nsec_hex';

/* مدة صلاحية إعلان وجود المستخدم في الغرفة */
const ROOM_PRESENCE_TTL = 45;

/* إعادة إعلان وجود المستخدم كل 15 ثانية */
const ROOM_HEARTBEAT_MS = 15000;

/* مدة اعتبار محاولة اتصال PeerJS عالقة */
const PEER_CONNECT_TIMEOUT = 15000;

/* ─────────────────────────────────────────────────────────────
   حالة التطبيق
   ───────────────────────────────────────────────────────────── */

let secretKeyHex = null;
let pk = null;
let npub = null;

const pool = new NostrTools.SimplePool();

/* منع تكرار المنشورات القادمة من أكثر من Relay */
const seenEvents = new Set();

/* اشتراك التفاعل اللحظي */
let interactionSub = null;

/* الأحداث التي تمت معالجتها بالفعل */
const seenInteractionEvents = new Set();

/*
 * حالة كل منشور:
 * {
 *   likes: Set(pubkey),
 *   replies: Set(eventId),
 *   optimisticLike: boolean
 * }
 */
const interactionState = new Map();

/* الإعجابات التي أرسلها المستخدم ولم نحصل على تأكيد Relay لها بعد */
const pendingLikes = new Map();

/* ─────────────────────────────────────────────────────────────
   حالة غرف WebRTC
   ───────────────────────────────────────────────────────────── */

let localStream = null;
let peer = null;
let currentRoom = null;
let currentPeerId = null;

let roomSub = null;
let roomHeartbeatTimer = null;

let isMuted = false;

/*
 * نخزن MediaConnection لكل Peer حتى لا ننشئ اتصالين لنفس الشخص.
 * key = remote peerId
 */
const activeCalls = new Map();

/*
 * الأحداث التي رأيناها في signaling.
 * event.id يمنع معالجة نفس الإعلان القادم من عدة Relays.
 */
const seenRoomEvents = new Set();

/* ─────────────────────────────────────────────────────────────
   أدوات مساعدة عامة
   ───────────────────────────────────────────────────────────── */

function normalizeRoomName(value) {
    return String(value || '')
        .trim()
        .normalize('NFC')
        .toLowerCase()
        .replace(/\s+/g, ' ')
        .slice(0, 64);
}

function getTagValue(event, tagName) {
    const tag = event.tags?.find(
        tag => Array.isArray(tag) && tag[0] === tagName && tag[1]
    );

    return tag ? tag[1] : null;
}

function getAllTagValues(event, tagName) {
    return (event.tags || [])
        .filter(tag => Array.isArray(tag) && tag[0] === tagName && tag[1])
        .map(tag => tag[1]);
}

function isExpiredEvent(event) {
    const expiration = getTagValue(event, 'expiration');

    if (!expiration) {
        return false;
    }

    return Number(expiration) <= Math.floor(Date.now() / 1000);
}

function isRecentRoomPresence(event) {
    const now = Math.floor(Date.now() / 1000);
    const age = now - Number(event.created_at || 0);

    return age >= -10 && age <= ROOM_PRESENCE_TTL;
}

function getErrorMessage(error) {
    if (!error) {
        return 'خطأ غير معروف';
    }

    return error.message || error.type || String(error);
}

function delay(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

/* ─────────────────────────────────────────────────────────────
   Toast
   ───────────────────────────────────────────────────────────── */

let toastTimer = null;

function showToast(msg, type = 'success') {
    const toast = document.getElementById('toast');
    const icon = document.getElementById('toast-icon');
    const message = document.getElementById('toast-msg');

    if (!toast || !icon || !message) {
        console.log('[Toast]', type, msg);
        return;
    }

    message.textContent = msg;

    if (type === 'error') {
        icon.className = 'fas fa-exclamation-circle text-red-400';
    } else if (type === 'info') {
        icon.className = 'fas fa-info-circle text-blue-400';
    } else {
        icon.className = 'fas fa-check-circle text-green-400';
    }

    toast.classList.remove('hidden');

    if (toastTimer) {
        clearTimeout(toastTimer);
    }

    toastTimer = setTimeout(() => {
        toast.classList.add('hidden');
    }, 3500);
}

/* ─────────────────────────────────────────────────────────────
   الهوية Nostr
   ───────────────────────────────────────────────────────────── */

function initIdentity() {
    try {
        let hexSk = localStorage.getItem(storageKey);

        const isValidHex =
            typeof hexSk === 'string' &&
            hexSk.length === 64 &&
            /^[0-9a-fA-F]{64}$/.test(hexSk);

        if (!isValidHex) {
            console.log('[Nostr] لا توجد هوية صالحة، يتم إنشاء هوية جديدة...');

            const newSkUint8 = NostrTools.generateSecretKey();

            hexSk = Array.from(newSkUint8)
                .map(byte => byte.toString(16).padStart(2, '0'))
                .join('');

            localStorage.setItem(storageKey, hexSk);
        }

        /*
         * مهم:
         * nostr-tools 2.x يقبل المفتاح السري Hex String مباشرة.
         * لا نحوله إلى Uint8Array قبل finalizeEvent().
         */
        secretKeyHex = hexSk;

        pk = NostrTools.getPublicKey(secretKeyHex);
        npub = NostrTools.nip19.npubEncode(pk);

        const display = document.getElementById('npub-display');

        if (display) {
            display.textContent =
                npub.slice(0, 8) + '...' + npub.slice(-6);
        }

        console.log('[Nostr] تم تحميل الهوية بنجاح:', {
            npub: npub,
            pubkey: pk
        });

    } catch (error) {
        console.error('[Nostr] خطأ حرج أثناء تهيئة الهوية:', error);

        localStorage.removeItem(storageKey);

        showToast(
            'تعذر تهيئة هوية Nostr، سيتم إنشاء هوية جديدة.',
            'error'
        );

        /*
         * إعادة المحاولة مرة واحدة فقط.
         */
        try {
            const newSkUint8 = NostrTools.generateSecretKey();

            const newHex = Array.from(newSkUint8)
                .map(byte => byte.toString(16).padStart(2, '0'))
                .join('');

            localStorage.setItem(storageKey, newHex);

            secretKeyHex = newHex;
            pk = NostrTools.getPublicKey(secretKeyHex);
            npub = NostrTools.nip19.npubEncode(pk);

            const display = document.getElementById('npub-display');

            if (display) {
                display.textContent =
                    npub.slice(0, 8) + '...' + npub.slice(-6);
            }

        } catch (retryError) {
            console.error(
                '[Nostr] فشل نهائي في إنشاء الهوية:',
                retryError
            );

            showToast(
                'فشل إنشاء هوية Nostr. تحقق من Console.',
                'error'
            );
        }
    }
}

/* ─────────────────────────────────────────────────────────────
   نشر أحداث Nostr بطريقة آمنة
   ───────────────────────────────────────────────────────────── */

async function publishEvent(event) {
    /*
     * pool.publish() في nostr-tools يعيد مجموعة من Promises.
     * لذلك Object.values(results) من الكود القديم غير صحيح.
     */
    const publishPromises = pool.publish(RELAYS, event);

    const results = await Promise.allSettled(publishPromises);

    const successful = results.filter(
        result => result.status === 'fulfilled'
    );

    const failed = results.filter(
        result => result.status === 'rejected'
    );

    if (failed.length > 0) {
        console.warn(
            '[Nostr] بعض الـ Relays رفضت/فشلت في استقبال الحدث:',
            failed.map(result => result.reason)
        );
    }

    return {
        successCount: successful.length,
        failureCount: failed.length,
        results
    };
}

/* ─────────────────────────────────────────────────────────────
   Feed
   ───────────────────────────────────────────────────────────── */

function startFeed() {
    const loading = document.getElementById('loading-feed');

    if (loading) {
        loading.classList.remove('hidden');
    }

    console.log('[Feed] بدء الاشتراك في المنشورات...');

    /*
     * مهم جداً:
     *
     * subscribeMany(relays, FILTER, params)
     *
     * وليس:
     *
     * subscribeMany(relays, [FILTER], params)
     *
     * وهذا كان أحد الأخطاء الأساسية في الكود السابق.
     */
    pool.subscribeMany(
        RELAYS,
        {
            kinds: [1],
            '#t': [APP_TAG],
            limit: 30
        },
        {
            onevent: event => {
                if (seenEvents.has(event.id)) {
                    return;
                }

                /*
                 * الردود kind 1 تحتوي e tag.
                 * لا نريد عرض الرد كمنشور رئيسي في الـ Feed.
                 */
                const hasParentEvent = getAllTagValues(event, 'e').length > 0;

                if (hasParentEvent) {
                    return;
                }

                seenEvents.add(event.id);

                renderPost(event);
            },

            oneose: () => {
                if (loading) {
                    loading.classList.add('hidden');
                }

                console.log('[Feed] انتهى تحميل المنشورات القديمة.');
            },

            onclose: reasons => {
                console.warn(
                    '[Feed] تم إغلاق اشتراك المنشورات:',
                    reasons
                );
            }
        }
    );
}

/* ─────────────────────────────────────────────────────────────
   حالة التفاعلات
   ───────────────────────────────────────────────────────────── */

function ensureInteractionState(postId) {
    if (!interactionState.has(postId)) {
        interactionState.set(postId, {
            likes: new Set(),
            replies: new Set(),
            optimisticLike: false
        });
    }

    return interactionState.get(postId);
}

function getPostCard(postId) {
    return document.querySelector(
        `.post-card[data-event-id="${postId}"]`
    );
}

function updatePostCounters(postId) {
    const card = getPostCard(postId);

    if (!card) {
        return;
    }

    const state = ensureInteractionState(postId);

    const likeCounter = card.querySelector('[data-like-count]');
    const replyCounter = card.querySelector('[data-reply-count]');
    const likeButton = card.querySelector('[data-like-button]');

    /*
     * OptimisticLike موجود محلياً قبل وصول حدث Nostr.
     * إذا وصل الحدث من relay، سيتم استبداله بالـ pubkey الحقيقي
     * داخل Set بدون زيادة ثانية.
     */
    const optimisticCount = state.optimisticLike ? 1 : 0;
    const realLikeCount = state.likes.size;

    if (likeCounter) {
        likeCounter.textContent = String(
            realLikeCount + optimisticCount
        );
    }

    if (replyCounter) {
        replyCounter.textContent = String(state.replies.size);
    }

    if (likeButton) {
        const liked =
            state.optimisticLike ||
            state.likes.has(pk);

        likeButton.classList.toggle(
            'text-red-500',
            liked
        );

        likeButton.classList.toggle(
            'text-gray-400',
            !liked
        );

        likeButton.setAttribute(
            'aria-pressed',
            liked ? 'true' : 'false'
        );

        const icon = likeButton.querySelector('i');

        if (icon) {
            icon.className = liked
                ? 'fas fa-heart text-red-500'
                : 'far fa-heart';
        }
    }
}

/* ─────────────────────────────────────────────────────────────
   Real-time Nostr Interactions
   ───────────────────────────────────────────────────────────── */

function refreshInteractionSubscription() {
    if (interactionSub) {
        try {
            interactionSub.close();
        } catch (error) {
            console.warn(
                '[Realtime] خطأ أثناء إغلاق الاشتراك القديم:',
                error
            );
        }

        interactionSub = null;
    }

    const cards = Array.from(
        document.querySelectorAll('.post-card[data-event-id]')
    );

    const postIds = cards
        .map(card => card.dataset.eventId)
        .filter(Boolean);

    if (postIds.length === 0) {
        return;
    }

    console.log(
        '[Realtime] الاشتراك في تفاعلات المنشورات:',
        postIds.length
    );

    /*
     * اشتراك واحد:
     *
     * kind 7 = Likes / Reactions
     * kind 1 = Replies
     *
     * #e = المنشور الذي يشير إليه الحدث
     *
     * هذا يجعل التحديث لحظياً دون Refresh.
     */
    interactionSub = pool.subscribeMany(
        RELAYS,
        {
            kinds: [7, 1],
            '#e': postIds,
            limit: 500
        },
        {
            onevent: event => {
                if (!event || !event.id) {
                    return;
                }

                /*
                 * نفس الحدث يصل غالباً من أكثر من Relay.
                 */
                if (seenInteractionEvents.has(event.id)) {
                    return;
                }

                seenInteractionEvents.add(event.id);

                const targetIds = getAllTagValues(event, 'e');

                if (targetIds.length === 0) {
                    return;
                }

                /*
                 * في NIP-25، الـ e tag الأخير هو الهدف الأساسي.
                 */
                const targetId =
                    targetIds[targetIds.length - 1];

                if (!postIds.includes(targetId)) {
                    return;
                }

                const state =
                    ensureInteractionState(targetId);

                if (event.kind === 7) {
                    /*
                     * + أو content فارغ = Like.
                     */
                    const reaction =
                        typeof event.content === 'string'
                            ? event.content.trim()
                            : '+';

                    if (reaction === '+' || reaction === '') {
                        /*
                         * إذا كان هذا هو إعجاب المستخدم نفسه،
                         * نحذف الـ optimistic placeholder أولاً.
                         */
                        if (event.pubkey === pk) {
                            state.optimisticLike = false;
                            pendingLikes.delete(targetId);
                        }

                        /*
                         * Set يمنع عدّ نفس المستخدم أكثر من مرة.
                         */
                        state.likes.add(event.pubkey);

                        console.log(
                            '[Realtime] إعجاب جديد:',
                            {
                                postId: targetId,
                                pubkey: event.pubkey,
                                eventId: event.id
                            }
                        );

                        updatePostCounters(targetId);
                    }

                } else if (event.kind === 1) {
                    /*
                     * كل kind 1 مرتبط بالمنشور عبر e tag
                     * نعتبره Reply.
                     */
                    state.replies.add(event.id);

                    console.log(
                        '[Realtime] رد جديد:',
                        {
                            postId: targetId,
                            replyId: event.id,
                            pubkey: event.pubkey
                        }
                    );

                    updatePostCounters(targetId);
                }
            },

            onclose: reasons => {
                console.warn(
                    '[Realtime] تم إغلاق اشتراك التفاعلات:',
                    reasons
                );
            }
        }
    );
}

/* ─────────────────────────────────────────────────────────────
   Render Post
   ───────────────────────────────────────────────────────────── */

function renderPost(event) {
    const container =
        document.getElementById('feed-container');

    if (!container || !event) {
        return;
    }

    if (getPostCard(event.id)) {
        return;
    }

    const shortPubkey =
        event.pubkey.slice(0, 6);

    const time =
        new Date(event.created_at * 1000)
            .toLocaleTimeString('ar-EG', {
                hour: '2-digit',
                minute: '2-digit'
            });

    ensureInteractionState(event.id);

    const div = document.createElement('div');

    div.className =
        'post-card bg-white dark:bg-surface rounded-2xl p-4 shadow-sm border border-gray-100 dark:border-gray-800 fade-in';

    /*
     * data-event-id هو المفتاح الذي يسمح لـ Real-time
     * subscription بتحديث المنشور الصحيح بدون إعادة الرسم.
     */
    div.dataset.eventId = event.id;

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

        <p class="text-gray-800 dark:text-gray-200 leading-relaxed mb-4 whitespace-pre-wrap text-sm md:text-base">
            ${escapeHtml(event.content)}
        </p>

        <div class="flex items-center gap-6 text-gray-400 text-sm border-t border-gray-100 dark:border-gray-800 pt-3">

            <button
                type="button"
                data-like-button
                data-post-id="${event.id}"
                onclick="likePost('${event.id}', '${event.pubkey}')"
                class="flex items-center gap-2 hover:text-red-500 transition"
                aria-pressed="false"
            >
                <i class="far fa-heart"></i>

                <span>إعجاب</span>

                <span
                    data-like-count
                    class="text-xs min-w-[1rem] text-center"
                >0</span>
            </button>

            <button
                type="button"
                data-reply-button
                data-post-id="${event.id}"
                onclick="replyToPost('${event.id}', '${event.pubkey}')"
                class="flex items-center gap-2 hover:text-blue-500 transition"
            >
                <i class="far fa-comment"></i>

                <span>رد</span>

                <span
                    data-reply-count
                    class="text-xs min-w-[1rem] text-center"
                >0</span>
            </button>

        </div>
    `;

    container.prepend(div);

    /*
     * بعد إضافة منشور جديد إلى DOM نعيد بناء
     * subscription الخاص بالتفاعلات لكي يشمله.
     */
    refreshInteractionSubscription();
}

/* ─────────────────────────────────────────────────────────────
   نشر منشور
   ───────────────────────────────────────────────────────────── */

async function publishPost() {
    const input =
        document.getElementById('post-input');

    if (!input) {
        return;
    }

    const content = input.value.trim();

    if (!content) {
        return;
    }

    if (!secretKeyHex) {
        showToast(
            'الهوية غير جاهزة بعد، حاول مرة أخرى.',
            'error'
        );

        return;
    }

    try {
        const eventTemplate = {
            kind: 1,
            created_at: Math.floor(Date.now() / 1000),
            tags: [
                ['t', APP_TAG]
            ],
            content
        };

        /*
         * لا نحول secretKeyHex إلى Uint8Array هنا.
         */
        const signedEvent =
            NostrTools.finalizeEvent(
                eventTemplate,
                secretKeyHex
            );

        console.log(
            '[Nostr] نشر منشور:',
            signedEvent.id
        );

        showToast(
            'جاري النشر عبر شبكة Nostr...',
            'info'
        );

        const result =
            await publishEvent(signedEvent);

        if (result.successCount > 0) {
            input.value = '';

            /*
             * تحديث Optimistic محلي أيضاً:
             * لو كانت Relay بطيئة، لا نحتاج انتظارها لرؤية المنشور.
             */
            if (!seenEvents.has(signedEvent.id)) {
                seenEvents.add(signedEvent.id);
                renderPost(signedEvent);
            }

            showToast(
                `تم النشر بنجاح عبر ${result.successCount} Relay`,
                'success'
            );

        } else {
            console.error(
                '[Nostr] فشل نشر المنشور في كل Relays'
            );

            showToast(
                'فشل النشر: لم تستجب أي Relay.',
                'error'
            );
        }

    } catch (error) {
        console.error(
            '[Nostr] Publish Error:',
            error
        );

        showToast(
            'فشل النشر: ' + getErrorMessage(error),
            'error'
        );
    }
}

/* ─────────────────────────────────────────────────────────────
   Optimistic Like
   ───────────────────────────────────────────────────────────── */

async function likePost(targetId, targetPubkey) {
    if (!targetId || !targetPubkey) {
        return;
    }

    if (!secretKeyHex || !pk) {
        showToast(
            'هوية Nostr غير جاهزة.',
            'error'
        );

        return;
    }

    const state =
        ensureInteractionState(targetId);

    /*
     * إذا كان المستخدم قد أعجب بالفعل،
     * لا ننشر نفس الإعجاب عشرات المرات.
     */
    if (
        state.likes.has(pk) ||
        state.optimisticLike ||
        pendingLikes.has(targetId)
    ) {
        return;
    }

    /*
     * ==========================================================
     * OPTIMISTIC UI
     * ==========================================================
     *
     * نغير الواجهة فوراً قبل الاتصال بالـ Relay.
     */
    state.optimisticLike = true;

    pendingLikes.set(targetId, true);

    updatePostCounters(targetId);

    console.log(
        '[Optimistic UI] تم تفعيل الإعجاب فوراً:',
        targetId
    );

    try {
        const eventTemplate = {
            kind: 7,
            created_at: Math.floor(Date.now() / 1000),

            /*
             * NIP-25:
             * e = المنشور
             * p = صاحب المنشور
             * k = نوع الحدث الذي نعمل له Like
             */
            tags: [
                ['e', targetId],
                ['p', targetPubkey],
                ['k', '1']
            ],

            content: '+'
        };

        /*
         * secretKeyHex يبقى Hex String مباشرة.
         */
        const signedEvent =
            NostrTools.finalizeEvent(
                eventTemplate,
                secretKeyHex
            );

        console.log(
            '[Nostr] Like event:',
            signedEvent
        );

        const result =
            await publishEvent(signedEvent);

        if (result.successCount > 0) {
            /*
             * لا نزيد العدد مرة أخرى هنا.
             * عندما يصل نفس event من subscribeMany:
             * state.likes.add(pk)
             * ثم يتم حذف optimisticLike.
             */
            showToast(
                'تم الإعجاب',
                'success'
            );

        } else {
            /*
             * Rollback في حالة فشل كل Relays.
             */
            state.optimisticLike = false;
            pendingLikes.delete(targetId);

            updatePostCounters(targetId);

            console.error(
                '[Optimistic UI] فشل نشر الإعجاب في كل Relays'
            );

            showToast(
                'فشل الإعجاب: لم تستجب أي Relay.',
                'error'
            );
        }

    } catch (error) {
        console.error(
            '[Nostr] Like Error:',
            error
        );

        /*
         * Rollback Optimistic UI.
         */
        state.optimisticLike = false;
        pendingLikes.delete(targetId);

        updatePostCounters(targetId);

        showToast(
            'فشل الإعجاب: ' + getErrorMessage(error),
            'error'
        );
    }
}

/* ─────────────────────────────────────────────────────────────
   Reply
   ───────────────────────────────────────────────────────────── */

async function replyToPost(targetId, targetPubkey) {
    const content =
        window.prompt('اكتب ردك:');

    if (!content || !content.trim()) {
        return;
    }

    if (!secretKeyHex) {
        showToast(
            'هوية Nostr غير جاهزة.',
            'error'
        );

        return;
    }

    try {
        const eventTemplate = {
            kind: 1,
            created_at: Math.floor(Date.now() / 1000),

            /*
             * NIP-10 style reply:
             * e يشير إلى المنشور الأصلي.
             */
            tags: [
                ['e', targetId, '', 'reply'],
                ['p', targetPubkey],
                ['t', APP_TAG]
            ],

            content: content.trim()
        };

        const signedEvent =
            NostrTools.finalizeEvent(
                eventTemplate,
                secretKeyHex
            );

        console.log(
            '[Nostr] نشر رد:',
            signedEvent
        );

        showToast(
            'جاري إرسال الرد...',
            'info'
        );

        const result =
            await publishEvent(signedEvent);

        if (result.successCount > 0) {
            /*
             * Optimistic reply counter:
             * نزيده فوراً دون انتظار الاشتراك.
             *
             * وعندما يصل الحدث من Relay، Set(event.id)
             * تمنع الزيادة الثانية.
             */
            const state =
                ensureInteractionState(targetId);

            state.replies.add(signedEvent.id);

            updatePostCounters(targetId);

            /*
             * نضيفه إلى seen حتى لا يعاد رسمه كمنشور رئيسي.
             */
            seenInteractionEvents.add(signedEvent.id);

            showToast(
                'تم إرسال الرد',
                'success'
            );

        } else {
            console.error(
                '[Nostr] فشل إرسال الرد في كل Relays'
            );

            showToast(
                'فشل الرد: لم تستجب أي Relay.',
                'error'
            );
        }

    } catch (error) {
        console.error(
            '[Nostr] Reply Error:',
            error
        );

        showToast(
            'فشل إرسال الرد: ' +
            getErrorMessage(error),
            'error'
        );
    }
}

/* ============================================================
   VOICE ROOMS — WebRTC / PeerJS
   ============================================================ */

/* ─────────────────────────────────────────────────────────────
   PeerJS / ICE Configuration
   ───────────────────────────────────────────────────────────── */

/*
 * ملاحظة مهمة:
 *
 * Google STUN = يساعد في اكتشاف المسار العام.
 * TURN = fallback عندما لا يستطيع الطرفان إنشاء P2P مباشر.
 *
 * لا يوجد TURN مجاني عام من Google.
 *
 * نستخدم:
 * 1. Google STUN
 * 2. عدة Google STUN endpoints
 * 3. TURN الخاص بـ PeerJS Cloud كـ fallback.
 *
 * في الإنتاج عالي الحجم، الأفضل تشغيل coturn خاص بك
 * بمعلومات اعتماد مؤقتة.
 */
const PEER_ICE_CONFIG = {
    iceServers: [
        {
            urls: 'stun:stun.l.google.com:19302'
        },
        {
            urls: 'stun:stun1.l.google.com:19302'
        },
        {
            urls: 'stun:stun2.l.google.com:19302'
        },

        /*
         * TURN fallback الخاص بخدمة PeerJS.
         *
         * إذا غيرت PeerJS هذه الخدمة مستقبلاً،
         * استخدم TURN server خاصاً بك.
         */
        {
            urls: [
                'turn:0.peerjs.com:3478'
            ],
            username: 'peerjs',
            credential: 'peerjsp'
        }
    ],

    sdpSemantics: 'unified-plan'
};

/* ─────────────────────────────────────────────────────────────
   تحويل أخطاء المايك إلى رسالة مفهومة
   ───────────────────────────────────────────────────────────── */

function getMicrophoneErrorMessage(error) {
    if (!error) {
        return 'خطأ غير معروف في الميكروفون.';
    }

    switch (error.name) {
        case 'NotAllowedError':
            return 'تم رفض صلاحية الميكروفون. اسمح للموقع باستخدام الميكروفون من إعدادات المتصفح.';

        case 'PermissionDeniedError':
            return 'تم رفض صلاحية الميكروفون من المتصفح.';

        case 'NotFoundError':
            return 'لم يتم العثور على ميكروفون متصل بالجهاز.';

        case 'NotReadableError':
            return 'الميكروفون موجود لكنه مستخدم من تطبيق آخر أو تعذر الوصول إليه.';

        case 'OverconstrainedError':
            return 'إعدادات الميكروفون المطلوبة غير مدعومة على هذا الجهاز.';

        case 'SecurityError':
            return 'المتصفح منع الوصول إلى الميكروفون لأسباب أمنية.';

        case 'AbortError':
            return 'تم إلغاء الوصول إلى الميكروفون.';

        default:
            return (
                'تعذر تشغيل الميكروفون: ' +
                getErrorMessage(error)
            );
    }
}

/* ─────────────────────────────────────────────────────────────
   تحويل أخطاء PeerJS إلى رسالة مفهومة
   ───────────────────────────────────────────────────────────── */

function getPeerErrorMessage(error) {
    const type = error?.type || '';
    const message = getErrorMessage(error);

    switch (type) {
        case 'browser-incompatible':
            return 'المتصفح لا يدعم WebRTC بشكل كافٍ.';

        case 'network':
            return 'تعذر الاتصال بخادم PeerJS. تحقق من الشبكة أو جدار الحماية.';

        case 'peer-unavailable':
            return 'الطرف الآخر لم يعد متاحاً. ربما غادر الغرفة.';

        case 'server-error':
            return 'خادم PeerJS لم يستجب بشكل صحيح.';

        case 'socket-error':
            return 'حدث خطأ في قناة الاتصال مع PeerJS.';

        case 'socket-closed':
            return 'انقطع اتصال الإشارة مع PeerJS.';

        case 'ssl-unavailable':
            return 'PeerJS رفض الاتصال الآمن. تأكد أن الموقع يعمل عبر HTTPS.';

        case 'unavailable-id':
            return 'معرف PeerJS مستخدم بالفعل. سيتم إنشاء معرف آخر.';

        case 'invalid-id':
            return 'معرف PeerJS غير صالح.';

        case 'webrtc':
            return 'حدث خطأ WebRTC أثناء إنشاء الاتصال.';

        case 'disconnected':
            return 'انقطع اتصال PeerJS بخادم الإشارة.';

        default:
            return (
                'خطأ PeerJS [' +
                (type || 'unknown') +
                ']: ' +
                message
            );
    }
}

/* ─────────────────────────────────────────────────────────────
   دخول / مغادرة الغرفة
   ───────────────────────────────────────────────────────────── */

async function toggleRoom(forceLeave = false) {
    const btn =
        document.getElementById('btn-join-room');

    const input =
        document.getElementById('room-input');

    const activeUi =
        document.getElementById('active-room-ui');

    if (!btn || !input || !activeUi) {
        console.error(
            '[Room] عناصر واجهة الغرفة غير موجودة.'
        );

        return;
    }

    /*
     * إذا كانت الغرفة مفتوحة بالفعل أو طلبنا مغادرة إجبارية،
     * ننفذ Leave.
     */
    if (forceLeave || currentRoom) {
        leaveRoom();
        return;
    }

    /*
     * ==========================================================
     * BUG FIX مهم جداً
     * ==========================================================
     *
     * الكود القديم كان يفحص:
     *
     * if (!currentRoom) leaveRoom()
     *
     * قبل أن يقرأ room-input.
     *
     * لذلك أول ضغط على "دخول" كان يعامل العملية كمغادرة.
     *
     * الآن نقرأ اسم الغرفة أولاً.
     */
    const roomName =
        normalizeRoomName(input.value);

    if (!roomName) {
        showToast(
            'اكتب اسم الغرفة أولاً.',
            'error'
        );

        input.focus();
        return;
    }

    if (!window.isSecureContext) {
        console.error(
            '[Room] الموقع ليس Secure Context:',
            location.href
        );

        showToast(
            'الغرف الصوتية تحتاج HTTPS. افتح الموقع عبر GitHub Pages HTTPS.',
            'error'
        );

        return;
    }

    if (
        !navigator.mediaDevices ||
        !navigator.mediaDevices.getUserMedia
    ) {
        console.error(
            '[Room] getUserMedia غير متاح في هذا المتصفح.'
        );

        showToast(
            'المتصفح لا يدعم الوصول إلى الميكروفون.',
            'error'
        );

        return;
    }

    /*
     * ثبت اسم الغرفة قبل إنشاء Peer.
     */
    currentRoom = roomName;

    input.value = currentRoom;
    input.disabled = true;

    btn.disabled = true;
    btn.textContent = 'جاري الاتصال...';

    try {
        /*
         * 1. الحصول على الميكروفون أولاً.
         */
        await acquireLocalMicrophone();

        /*
         * 2. إنشاء PeerJS.
         */
        await createPeerConnection();

        /*
         * 3. تحديث UI.
         */
        document.getElementById(
            'current-room-name'
        ).textContent =
            `غرفة: ${currentRoom}`;

        activeUi.classList.remove('hidden');

        btn.textContent = 'مغادرة';

        btn.classList.add(
            'bg-red-500',
            'text-white'
        );

        btn.classList.remove(
            'bg-white',
            'text-accent'
        );

        btn.disabled = false;

        localStorage.setItem(
            'active_room',
            currentRoom
        );

        console.log(
            '[Room] تم دخول الغرفة:',
            currentRoom
        );

        showToast(
            `تم دخول غرفة "${currentRoom}"`,
            'success'
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
         * Rollback كامل في حالة الفشل.
         */
        cleanupRoomResources();

        currentRoom = null;
        currentPeerId = null;

        input.disabled = false;
        input.value = '';

        btn.disabled = false;
        btn.textContent = 'دخول';

        btn.classList.remove(
            'bg-red-500',
            'text-white'
        );

        btn.classList.add(
            'bg-white',
            'text-accent'
        );

        activeUi.classList.add('hidden');

        localStorage.removeItem('active_room');
    }
}

/* ─────────────────────────────────────────────────────────────
   Microphone
   ───────────────────────────────────────────────────────────── */

async function acquireLocalMicrophone() {
    console.log(
        '[WebRTC] طلب صلاحية الميكروفون...'
    );

    try {
        localStream =
            await navigator.mediaDevices.getUserMedia({
                audio: {
                    echoCancellation: true,
                    noiseSuppression: true,
                    autoGainControl: true,
                    channelCount: 1
                },
                video: false
            });

        const tracks =
            localStream.getAudioTracks();

        if (!tracks.length) {
            throw new Error(
                'لم يتم الحصول على AudioTrack.'
            );
        }

        console.log(
            '[WebRTC] الميكروفون جاهز:',
            tracks.map(track => ({
                label: track.label,
                enabled: track.enabled,
                readyState: track.readyState
            }))
        );

    } catch (error) {
        console.error(
            '[WebRTC] Microphone Error:',
            {
                name: error?.name,
                message: error?.message,
                error
            }
        );

        showToast(
            getMicrophoneErrorMessage(error),
            'error'
        );

        throw error;
    }
}

/* ─────────────────────────────────────────────────────────────
   إنشاء PeerJS
   ───────────────────────────────────────────────────────────── */

function createPeerConnection() {
    return new Promise((resolve, reject) => {
        try {
            if (typeof Peer === 'undefined') {
                reject(
                    new Error(
                        'مكتبة PeerJS غير محملة في index.html.'
                    )
                );

                return;
            }

            /*
             * لا نحدد Peer ID يدوياً.
             *
             * PeerJS Cloud ينشئ ID عشوائياً وفريداً،
             * مما يقلل مشكلة unavailable-id / ID collision.
             */
            peer = new Peer({
                host: '0.peerjs.com',
                port: 443,
                secure: true,

                /*
                 * ICE / STUN / TURN configuration.
                 */
                config: PEER_ICE_CONFIG,

                /*
                 * Debug 2 يعطي أخطاء وتحذيرات مفيدة
                 * في Console بدون إغراق كامل.
                 */
                debug: 2
            });

            let settled = false;

            const resolveOnce = () => {
                if (settled) {
                    return;
                }

                settled = true;
                resolve();
            };

            const rejectOnce = error => {
                if (settled) {
                    return;
                }

                settled = true;
                reject(error);
            };

            /*
             * PeerServer signaling connection.
             */
            peer.on('open', id => {
                currentPeerId = id;

                console.log(
                    '[PeerJS] Peer مفتوح:',
                    {
                        id,
                        room: currentRoom,
                        pubkey: pk
                    }
                );

                /*
                 * نبدأ signaling عبر Nostr بعد حصولنا
                 * على Peer ID الحقيقي.
                 */
                announcePresence();

                /*
                 * نبدأ الاستماع فوراً.
                 */
                listenForPeers();

                /*
                 * Heartbeat يمنع المستخدم الجديد من محاولة
                 * الاتصال بـ Peer قديم.
                 */
                startRoomHeartbeat();

                resolveOnce();
            });

            /*
             * اتصال وارد من Peer آخر.
             */
            peer.on('call', call => {
                handleIncomingCall(call);
            });

            /*
             * خطأ عام في PeerJS.
             */
            peer.on('error', error => {
                console.error(
                    '[PeerJS] Error:',
                    {
                        type: error?.type,
                        message: error?.message,
                        error
                    }
                );

                const friendly =
                    getPeerErrorMessage(error);

                showToast(
                    friendly,
                    'error'
                );

                /*
                 * إذا فشل إنشاء Peer نفسه،
                 * reject عملية الدخول.
                 */
                if (!settled) {
                    rejectOnce(error);
                }
            });

            /*
             * PeerJS signaling connection dropped.
             */
            peer.on('disconnected', () => {
                console.warn(
                    '[PeerJS] انقطع الاتصال بخادم الإشارة.'
                );

                showToast(
                    'انقطع اتصال الإشارة، محاولة إعادة الاتصال...',
                    'error'
                );

                /*
                 * WebRTC connections الموجودة قد تبقى حية،
                 * لكن نحتاج PeerServer للإشارات الجديدة.
                 */
                if (
                    peer &&
                    !peer.destroyed &&
                    peer.disconnected &&
                    currentRoom
                ) {
                    setTimeout(() => {
                        try {
                            if (
                                peer &&
                                !peer.destroyed &&
                                peer.disconnected
                            ) {
                                peer.reconnect();

                                console.log(
                                    '[PeerJS] محاولة reconnect...'
                                );
                            }
                        } catch (error) {
                            console.error(
                                '[PeerJS] فشل reconnect:',
                                error
                            );
                        }
                    }, 1500);
                }
            });

            peer.on('close', () => {
                console.warn(
                    '[PeerJS] تم إغلاق Peer.'
                );
            });

        } catch (error) {
            console.error(
                '[PeerJS] فشل إنشاء Peer:',
                error
            );

            reject(error);
        }
    });
}

/* ─────────────────────────────────────────────────────────────
   Nostr Signaling — Presence
   ───────────────────────────────────────────────────────────── */

async function announcePresence() {
    if (
        !currentRoom ||
        !currentPeerId ||
        !secretKeyHex ||
        !pk
    ) {
        console.warn(
            '[Room Signaling] لا يمكن نشر Presence:',
            {
                currentRoom,
                currentPeerId,
                hasSecretKey: Boolean(secretKeyHex),
                hasPubkey: Boolean(pk)
            }
        );

        return;
    }

    const now =
        Math.floor(Date.now() / 1000);

    const expiration =
        now + ROOM_PRESENCE_TTL;

    /*
     * ==========================================================
     * NOSTR ROOM SIGNALING
     * ==========================================================
     *
     * r = room identifier
     * t = application room tag
     * p = صاحب الإعلان
     *
     * مهم:
     * لا نستخدم #room لأن Nostr tag filters تعتمد على
     * حرف واحد مثل #r أو #t أو #e.
     */
    const eventTemplate = {
        kind: 1,
        created_at: now,

        tags: [
            ['t', ROOM_TAG],
            ['r', currentRoom],
            ['p', pk],
            ['expiration', String(expiration)],
            ['client', 'pulse'],
            ['version', '2']
        ],

        content: JSON.stringify({
            type: 'room-presence',
            room: currentRoom,
            peerId: currentPeerId,
            pubkey: pk,
            npub: npub
                ? npub.slice(0, 12)
                : '',
            expiresAt: expiration
        })
    };

    try {
        const signedEvent =
            NostrTools.finalizeEvent(
                eventTemplate,
                secretKeyHex
            );

        console.log(
            '[Room Signaling] نشر Presence:',
            {
                eventId: signedEvent.id,
                room: currentRoom,
                peerId: currentPeerId
            }
        );

        const result =
            await publishEvent(signedEvent);

        if (result.successCount === 0) {
            console.error(
                '[Room Signaling] فشل نشر Presence في كل Relays.'
            );
        }

    } catch (error) {
        console.error(
            '[Room Signaling] Presence Error:',
            error
        );

        showToast(
            'تعذر نشر وجودك في الغرفة عبر Nostr.',
            'error'
        );
    }
}

/* ─────────────────────────────────────────────────────────────
   Heartbeat
   ───────────────────────────────────────────────────────────── */

function startRoomHeartbeat() {
    stopRoomHeartbeat();

    roomHeartbeatTimer =
        setInterval(() => {
            if (
                currentRoom &&
                peer &&
                !peer.destroyed &&
                currentPeerId
            ) {
                announcePresence();
            }
        }, ROOM_HEARTBEAT_MS);
}

function stopRoomHeartbeat() {
    if (roomHeartbeatTimer) {
        clearInterval(roomHeartbeatTimer);
        roomHeartbeatTimer = null;
    }
}

/* ─────────────────────────────────────────────────────────────
   Nostr Signaling — Listen
   ───────────────────────────────────────────────────────────── */

function listenForPeers() {
    if (!currentRoom) {
        console.warn(
            '[Room Signaling] لا توجد غرفة للاستماع إليها.'
        );

        return;
    }

    if (roomSub) {
        try {
            roomSub.close();
        } catch (error) {
            console.warn(
                '[Room Signaling] فشل إغلاق subscription القديم:',
                error
            );
        }
    }

    console.log(
        '[Room Signaling] الاستماع إلى الغرفة:',
        currentRoom
    );

    /*
     * ==========================================================
     * FIX:
     * subscribeMany يستقبل Filter object مباشرة.
     * ==========================================================
     *
     * الخطأ القديم:
     *
     * [{ kinds: [1], '#room': [currentRoom] }]
     *
     * الصحيح:
     *
     * { kinds: [1], '#r': [currentRoom] }
     */
    roomSub = pool.subscribeMany(
        RELAYS,
        {
            kinds: [1],
            '#r': [currentRoom],
            limit: 50
        },
        {
            onevent: event => {
                handleRoomPresenceEvent(event);
            },

            onclose: reasons => {
                console.warn(
                    '[Room Signaling] تم إغلاق الاشتراك:',
                    reasons
                );

                /*
                 * لا نعرض Toast لكل Relay تغلق حتى لا نزعج المستخدم.
                 * لكن التفاصيل تبقى في Console.
                 */
            }
        }
    );
}

/* ─────────────────────────────────────────────────────────────
   معالجة Presence Event
   ───────────────────────────────────────────────────────────── */

function handleRoomPresenceEvent(event) {
    if (!event || !event.id) {
        return;
    }

    if (seenRoomEvents.has(event.id)) {
        return;
    }

    seenRoomEvents.add(event.id);

    /*
     * يجب أن يكون الحدث فعلاً إعلان غرفة.
     */
    if (
        getTagValue(event, 't') !== ROOM_TAG ||
        getTagValue(event, 'r') !== currentRoom
    ) {
        return;
    }

    /*
     * تجاهل الأحداث المنتهية.
     */
    if (isExpiredEvent(event)) {
        console.log(
            '[Room Signaling] تجاهل Presence منتهية:',
            event.id
        );

        return;
    }

    /*
     * تجاهل Presence قديمة جداً.
     */
    if (!isRecentRoomPresence(event)) {
        console.log(
            '[Room Signaling] تجاهل Presence قديمة:',
            {
                eventId: event.id,
                createdAt: event.created_at
            }
        );

        return;
    }

    if (event.pubkey === pk) {
        return;
    }

    let data;

    try {
        data = JSON.parse(event.content);
    } catch (error) {
        console.warn(
            '[Room Signaling] Presence content ليس JSON صالحاً:',
            {
                eventId: event.id,
                content: event.content
            }
        );

        return;
    }

    if (data.type !== 'room-presence') {
        return;
    }

    const targetPeerId =
        typeof data.peerId === 'string'
            ? data.peerId.trim()
            : '';

    const remotePubkey =
        typeof data.pubkey === 'string'
            ? data.pubkey
            : event.pubkey;

    if (!targetPeerId) {
        console.warn(
            '[Room Signaling] Presence بدون peerId:',
            event
        );

        return;
    }

    /*
     * تحقق إضافي من أن peerId ليس Peer الخاص بنا.
     */
    if (
        targetPeerId === currentPeerId ||
        targetPeerId === peer?.id
    ) {
        return;
    }

    /*
     * ==========================================================
     * منع الاتصال المزدوج
     * ==========================================================
     *
     * كل طرف يرى إعلان الطرف الآخر.
     *
     * لو جعلنا الطرفين ينفذان peer.call()،
     * قد نحصل على اتصالين MediaConnection لنفس الشخص.
     *
     * لذلك صاحب pubkey الأصغر فقط يبدأ الاتصال.
     * الطرف الآخر ينتظر call event ويجيب عليه.
     */
    if (pk > remotePubkey) {
        console.log(
            '[Room Signaling] الطرف الآخر هو Initiator:',
            {
                remotePubkey,
                localPubkey: pk,
                peerId: targetPeerId
            }
        );

        return;
    }

    console.log(
        '[Room Signaling] اكتشاف Peer جديد:',
        {
            eventId: event.id,
            targetPeerId,
            remotePubkey,
            room: currentRoom
        }
    );

    connectToPeer(
        targetPeerId,
        data.npub || remotePubkey.slice(0, 8),
        remotePubkey
    );
}

/* ─────────────────────────────────────────────────────────────
   الاتصال بـ Peer آخر
   ───────────────────────────────────────────────────────────── */

function connectToPeer(
    targetPeerId,
    displayName,
    remotePubkey
) {
    if (!peer || peer.destroyed) {
        console.error(
            '[WebRTC] لا يمكن الاتصال: PeerJS غير جاهز.'
        );

        return;
    }

    if (!localStream) {
        console.error(
            '[WebRTC] لا يمكن الاتصال: localStream غير موجود.'
        );

        showToast(
            'الميكروفون غير جاهز لإنشاء الاتصال.',
            'error'
        );

        return;
    }

    if (!targetPeerId) {
        console.error(
            '[WebRTC] Peer ID فارغ.'
        );

        return;
    }

    if (targetPeerId === currentPeerId) {
        return;
    }

    if (activeCalls.has(targetPeerId)) {
        console.log(
            '[WebRTC] الاتصال موجود مسبقاً:',
            targetPeerId
        );

        return;
    }

    console.log(
        '[WebRTC] بدء الاتصال بـ Peer:',
        {
            targetPeerId,
            displayName,
            remotePubkey
        }
    );

    let call;

    try {
        call = peer.call(
            targetPeerId,
            localStream,
            {
                metadata: {
                    room: currentRoom,
                    pubkey: pk,
                    displayName: npub
                        ? npub.slice(0, 12)
                        : ''
                }
            }
        );

        if (!call) {
            throw new Error(
                'peer.call() أعاد قيمة فارغة.'
            );
        }

        activeCalls.set(
            targetPeerId,
            call
        );

        attachCallHandlers(
            call,
            displayName || 'مستمع',
            targetPeerId
        );

    } catch (error) {
        console.error(
            '[WebRTC] فشل إنشاء call:',
            {
                targetPeerId,
                error
            }
        );

        showToast(
            'فشل بدء اتصال الصوت: ' +
            getErrorMessage(error),
            'error'
        );
    }
}

/* ─────────────────────────────────────────────────────────────
   Incoming Call
   ───────────────────────────────────────────────────────────── */

function handleIncomingCall(call) {
    if (!call) {
        return;
    }

    const remotePeerId = call.peer;

    console.log(
        '[WebRTC] اتصال صوتي وارد:',
        {
            remotePeerId,
            metadata: call.metadata
        }
    );

    if (!localStream) {
        console.error(
            '[WebRTC] اتصال وارد لكن الميكروفون المحلي غير موجود.'
        );

        try {
            call.close();
        } catch (error) {
            console.warn(
                '[WebRTC] فشل إغلاق الاتصال الوارد:',
                error
            );
        }

        return;
    }

    /*
     * لو يوجد اتصال سابق، لا ننشئ duplicate.
     */
    if (activeCalls.has(remotePeerId)) {
        console.warn(
            '[WebRTC] اتصال وارد مكرر:',
            remotePeerId
        );

        try {
            call.close();
        } catch (error) {
            console.warn(
                '[WebRTC] فشل إغلاق الاتصال المكرر:',
                error
            );
        }

        return;
    }

    try {
        /*
         * الإجابة على الاتصال.
         */
        call.answer(localStream);

        activeCalls.set(
            remotePeerId,
            call
        );

        const displayName =
            call.metadata?.displayName ||
            remotePeerId.slice(0, 8);

        attachCallHandlers(
            call,
            displayName,
            remotePeerId
        );

    } catch (error) {
        console.error(
            '[WebRTC] فشل answer للاتصال:',
            error
        );

        showToast(
            'فشل قبول اتصال الصوت: ' +
            getErrorMessage(error),
            'error'
        );
    }
}

/* ─────────────────────────────────────────────────────────────
   Call Handlers
   ───────────────────────────────────────────────────────────── */

function attachCallHandlers(
    call,
    displayName,
    remotePeerId
) {
    if (!call) {
        return;
    }

    let gotRemoteStream = false;

    /*
     * WebRTC MediaConnection يدعم iceStateChanged
     * في PeerJS 1.5.x.
     */
    call.on(
        'iceStateChanged',
        state => {
            console.log(
                '[WebRTC] ICE state:',
                {
                    peer: remotePeerId,
                    state
                }
            );

            switch (state) {
                case 'checking':
                    console.log(
                        '[WebRTC] جاري فحص مسارات ICE...'
                    );
                    break;

                case 'connected':
                case 'completed':
                    console.log(
                        '[WebRTC] تم إنشاء مسار WebRTC بنجاح:',
                        remotePeerId
                    );
                    break;

                case 'disconnected':
                    console.warn(
                        '[WebRTC] ICE disconnected:',
                        remotePeerId
                    );
                    break;

                case 'failed':
                    console.error(
                        '[WebRTC] ICE FAILED:',
                        {
                            peer: remotePeerId,
                            message:
                                'فشل NAT traversal. تحقق من STUN/TURN أو الشبكة.'
                        }
                    );

                    showToast(
                        'فشل مسار WebRTC. غالباً المشكلة NAT/Firewall/TURN.',
                        'error'
                    );

                    break;

                case 'closed':
                    console.log(
                        '[WebRTC] ICE closed:',
                        remotePeerId
                    );
                    break;

                default:
                    console.log(
                        '[WebRTC] ICE state:',
                        state
                    );
            }
        }
    );

    /*
     * وصول الصوت من الطرف الآخر.
     */
    call.on(
        'stream',
        remoteStream => {
            gotRemoteStream = true;

            console.log(
                '[WebRTC] تم استلام Remote Audio Stream:',
                {
                    peer: remotePeerId,
                    tracks:
                        remoteStream.getTracks().map(
                            track => ({
                                kind: track.kind,
                                label: track.label,
                                readyState:
                                    track.readyState
                            })
                        )
                }
            );

            addPeerAudio(
                remoteStream,
                displayName,
                remotePeerId
            );
        }
    );

    /*
     * خطأ MediaConnection.
     */
    call.on(
        'error',
        error => {
            console.error(
                '[WebRTC] MediaConnection Error:',
                {
                    peer: remotePeerId,
                    error,
                    message: getErrorMessage(error)
                }
            );

            showToast(
                'خطأ في صوت أحد المشاركين: ' +
                getErrorMessage(error),
                'error'
            );
        }
    );

    /*
     * إغلاق الاتصال.
     */
    call.on(
        'close',
        () => {
            console.log(
                '[WebRTC] تم إغلاق الاتصال:',
                remotePeerId
            );

            activeCalls.delete(
                remotePeerId
            );

            removePeerAudio(
                remotePeerId
            );
        }
    );

    /*
     * Timeout تشخيصي:
     * إذا لم يصل stream ولم يصبح الاتصال open
     * خلال مدة معقولة، نغلقه ونعطي رسالة واضحة.
     */
    setTimeout(() => {
        if (
            currentRoom &&
            activeCalls.get(remotePeerId) === call &&
            !gotRemoteStream &&
            !call.open
        ) {
            console.error(
                '[WebRTC] الاتصال عالق بدون Remote Stream:',
                {
                    peer: remotePeerId,
                    callOpen: call.open,
                    iceState:
                        call.peerConnection?.iceConnectionState
                }
            );

            showToast(
                'الاتصال الصوتي لم يكتمل. تحقق من NAT/TURN والشبكة.',
                'error'
            );

            try {
                call.close();
            } catch (error) {
                console.warn(
                    '[WebRTC] فشل إغلاق الاتصال العالق:',
                    error
                );
            }

            activeCalls.delete(
                remotePeerId
            );

            removePeerAudio(
                remotePeerId
            );
        }
    }, PEER_CONNECT_TIMEOUT);
}

/* ─────────────────────────────────────────────────────────────
   Remote Audio UI
   ───────────────────────────────────────────────────────────── */

function addPeerAudio(
    stream,
    name,
    remotePeerId
) {
    if (!stream || !remotePeerId) {
        return;
    }

    const peersList =
        document.getElementById('peers-list');

    if (!peersList) {
        return;
    }

    /*
     * إذا كان هناك Audio element سابق لهذا الـ Peer،
     * نحدث stream بدلاً من إنشاء عنصر جديد.
     */
    let audio =
        document.getElementById(
            `audio-${remotePeerId}`
        );

    if (!audio) {
        audio =
            document.createElement('audio');

        audio.id =
            `audio-${remotePeerId}`;

        audio.autoplay = true;
        audio.playsInline = true;

        /*
         * لا نعرض controls للمستخدم.
         */
        audio.controls = false;

        /*
         * لا نحتاج وضع audio في مكان مرئي.
         */
        audio.className = 'hidden';

        document.body.appendChild(audio);
    }

    audio.srcObject = stream;

    /*
     * محاولة تشغيل الصوت.
     */
    const playPromise =
        audio.play();

    if (
        playPromise &&
        typeof playPromise.catch === 'function'
    ) {
        playPromise.catch(error => {
            console.warn(
                '[WebRTC] المتصفح منع autoplay للصوت:',
                error
            );

            showToast(
                'تم الاتصال، لكن المتصفح منع تشغيل الصوت تلقائياً. اضغط على الصفحة مرة واحدة.',
                'error'
            );
        });
    }

    /*
     * معرف آمن مبني على Peer ID.
     */
    const uiId =
        `peer-${remotePeerId}`;

    let div =
        document.getElementById(uiId);

    if (!div) {
        div =
            document.createElement('div');

        div.id = uiId;

        div.className =
            'flex items-center gap-2 bg-gray-50 dark:bg-gray-800 p-2 rounded-lg';

        const dot =
            document.createElement('div');

        dot.className =
            'w-2 h-2 bg-green-500 rounded-full animate-pulse';

        const label =
            document.createElement('span');

        label.textContent =
            name || 'مستمع';

        div.appendChild(dot);
        div.appendChild(label);

        peersList.appendChild(div);
    }

    console.log(
        '[WebRTC] تمت إضافة/تحديث صوت:',
        {
            remotePeerId,
            name
        }
    );
}

function removePeerAudio(remotePeerId) {
    if (!remotePeerId) {
        return;
    }

    const audio =
        document.getElementById(
            `audio-${remotePeerId}`
        );

    if (audio) {
        try {
            audio.pause();
        } catch (error) {
            console.warn(
                '[WebRTC] فشل إيقاف audio:',
                error
            );
        }

        audio.srcObject = null;
        audio.remove();
    }

    const ui =
        document.getElementById(
            `peer-${remotePeerId}`
        );

    if (ui) {
        ui.remove();
    }
}

/* ─────────────────────────────────────────────────────────────
   Mute
   ───────────────────────────────────────────────────────────── */

function toggleMute() {
    if (!localStream) {
        showToast(
            'الميكروفون غير نشط.',
            'error'
        );

        return;
    }

    const tracks =
        localStream.getAudioTracks();

    if (!tracks.length) {
        showToast(
            'لا يوجد مسار صوتي للتحكم به.',
            'error'
        );

        return;
    }

    isMuted = !isMuted;

    tracks.forEach(track => {
        track.enabled = !isMuted;
    });

    const btn =
        document.getElementById('btn-mute');

    if (btn) {
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
    }

    console.log(
        '[WebRTC] Microphone:',
        isMuted ? 'MUTED' : 'UNMUTED'
    );

    showToast(
        isMuted
            ? 'تم كتم الميكروفون'
            : 'تم تشغيل الميكروفون',
        'success'
    );
}

/* ─────────────────────────────────────────────────────────────
   Leave Room
   ───────────────────────────────────────────────────────────── */

function leaveRoom() {
    console.log(
        '[Room] مغادرة الغرفة:',
        currentRoom
    );

    cleanupRoomResources();

    currentRoom = null;
    currentPeerId = null;

    localStorage.removeItem(
        'active_room'
    );

    const activeUi =
        document.getElementById(
            'active-room-ui'
        );

    const peersList =
        document.getElementById(
            'peers-list'
        );

    const btn =
        document.getElementById(
            'btn-join-room'
        );

    const input =
        document.getElementById(
            'room-input'
        );

    if (activeUi) {
        activeUi.classList.add('hidden');
    }

    if (peersList) {
        peersList.innerHTML = '';
    }

    if (btn) {
        btn.disabled = false;
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

    isMuted = false;

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

    showToast(
        'تمت مغادرة الغرفة',
        'success'
    );
}

/* ─────────────────────────────────────────────────────────────
   تنظيف موارد الغرفة
   ───────────────────────────────────────────────────────────── */

function cleanupRoomResources() {
    stopRoomHeartbeat();

    if (roomSub) {
        try {
            roomSub.close();
        } catch (error) {
            console.warn(
                '[Room] خطأ في إغلاق Nostr subscription:',
                error
            );
        }

        roomSub = null;
    }

    /*
     * إغلاق كل MediaConnections.
     */
    activeCalls.forEach(
        (call, remotePeerId) => {
            try {
                call.close();
            } catch (error) {
                console.warn(
                    '[WebRTC] فشل إغلاق call:',
                    remotePeerId,
                    error
                );
            }
        }
    );

    activeCalls.clear();

    /*
     * تدمير PeerJS.
     */
    if (peer) {
        try {
            if (!peer.destroyed) {
                peer.destroy();
            }
        } catch (error) {
            console.warn(
                '[PeerJS] فشل destroy:',
                error
            );
        }

        peer = null;
    }

    /*
     * إيقاف الميكروفون.
     */
    if (localStream) {
        localStream
            .getTracks()
            .forEach(track => {
                try {
                    track.stop();
                } catch (error) {
                    console.warn(
                        '[WebRTC] فشل إيقاف track:',
                        error
                    );
                }
            });

        localStream = null;
    }

    /*
     * إزالة كل عناصر الصوت.
     */
    document
        .querySelectorAll('audio[id^="audio-"]')
        .forEach(audio => {
            try {
                audio.pause();
            } catch (error) {
                // لا شيء
            }

            audio.srcObject = null;
            audio.remove();
        });

    seenRoomEvents.clear();
}

/* ─────────────────────────────────────────────────────────────
   Navigation
   ───────────────────────────────────────────────────────────── */

function switchView(viewName) {
    document
        .querySelectorAll('.view-section')
        .forEach(element => {
            element.classList.add('hidden');
        });

    const view =
        document.getElementById(
            `view-${viewName}`
        );

    if (view) {
        view.classList.remove('hidden');
    }

    document
        .querySelectorAll('.nav-btn')
        .forEach(element => {
            element.classList.remove(
                'text-accent',
                'active'
            );

            element.classList.add(
                'text-gray-400'
            );
        });

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
}

/* ─────────────────────────────────────────────────────────────
   Theme
   ───────────────────────────────────────────────────────────── */

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

/* ─────────────────────────────────────────────────────────────
   HTML escaping
   ───────────────────────────────────────────────────────────── */

function escapeHtml(text) {
    const div =
        document.createElement('div');

    div.textContent =
        String(text ?? '');

    return div.innerHTML;
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
        const savedTheme =
            localStorage.getItem('theme');

        if (
            savedTheme === 'dark' ||
            (
                !savedTheme &&
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
         * Nostr identity
         */
        initIdentity();

        /*
         * Feed + real-time interactions
         */
        startFeed();

        /*
         * Room restoration.
         *
         * إذا كان المستخدم دخل الغرفة قبل Refresh:
         * نضع الاسم في input ثم toggleRoom() سيقرأه
         * بالطريقة الصحيحة.
         */
        const savedRoom =
            localStorage.getItem(
                'active_room'
            );

        if (savedRoom) {
            const input =
                document.getElementById(
                    'room-input'
                );

            if (input) {
                input.value =
                    normalizeRoomName(
                        savedRoom
                    );

                setTimeout(() => {
                    /*
                     * currentRoom ما زالت null هنا،
                     * لذلك toggleRoom سيقرأ input ويدخل.
                     */
                    toggleRoom();
                }, 1000);
            }
        }

        /*
         * تسجيل حالة دعم WebRTC في Console.
         */
        console.log(
            '[WebRTC] Browser capabilities:',
            {
                secureContext:
                    window.isSecureContext,

                mediaDevices:
                    Boolean(
                        navigator.mediaDevices
                    ),

                getUserMedia:
                    Boolean(
                        navigator.mediaDevices?.getUserMedia
                    ),

                RTCPeerConnection:
                    typeof RTCPeerConnection !==
                    'undefined'
            }
        );
    }
);

/* ─────────────────────────────────────────────────────────────
   Service Worker
   ───────────────────────────────────────────────────────────── */

if ('serviceWorker' in navigator) {
    window.addEventListener(
        'load',
        () => {
            navigator.serviceWorker
                .register('./sw.js')
                .then(registration => {
                    console.log(
                        '[SW] Registered:',
                        registration.scope
                    );
                })
                .catch(error => {
                    console.warn(
                        '[SW] Registration failed:',
                        error
                    );
                });
        }
    );
}
