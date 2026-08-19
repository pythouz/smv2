function renderMediaContent(content) {
    if (!content) return '';

    let html = escapeHtml(content);

    // 1. معالجة روابط الصور
    html = html.replace(
        /(https?:\/\/[^\s<>"']+\.(jpe?g|png|gif|webp|svg|bmp|ico)(\?[^\s<>"']*)?)/gi,
        (match) => {
            return `<img src="${match}" alt="صورة" class="max-w-full rounded-xl my-2 max-h-[500px] object-contain border border-gray-200 dark:border-gray-700 shadow-sm" loading="lazy" onerror="this.style.display='none'" />`;
        }
    );

    // 2. معالجة روابط الفيديو
    html = html.replace(
        /(https?:\/\/[^\s<>"']+\.(mp4|webm|mov|avi|mkv|ogg)(\?[^\s<>"']*)?)/gi,
        (match) => {
            return `<video src="${match}" controls class="max-w-full rounded-xl my-2 max-h-[500px] w-full border border-gray-200 dark:border-gray-700 shadow-sm" preload="metadata" playsinline></video>`;
        }
    );

    // 3. معالجة روابط YouTube
    html = html.replace(
        /(?:https?:\/\/)?(?:www\.)?(?:youtube\.com\/watch\?v=|youtu\.be\/)([a-zA-Z0-9_-]{11})/gi,
        (match, videoId) => {
            return `<iframe class="w-full rounded-xl my-2 aspect-video border border-gray-200 dark:border-gray-700 shadow-sm" src="https://www.youtube.com/embed/${videoId}" frameborder="0" allowfullscreen loading="lazy"></iframe>`;
        }
    );

    // 4. معالجة روابط Vimeo
    html = html.replace(
        /(?:https?:\/\/)?(?:www\.)?vimeo\.com\/(\d+)/gi,
        (match, videoId) => {
            return `<iframe class="w-full rounded-xl my-2 aspect-video border border-gray-200 dark:border-gray-700 shadow-sm" src="https://player.vimeo.com/video/${videoId}" frameborder="0" allowfullscreen loading="lazy"></iframe>`;
        }
    );

    // 5. تحويل الروابط العامة إلى روابط قابلة للنقر
    html = html.replace(
        /(https?:\/\/[^\s<>"']+)(?![^<]*<\/?(?:img|video|iframe)>)/gi,
        (match) => {
            return `<a href="${match}" target="_blank" rel="noopener noreferrer" class="text-accent hover:underline">${match}</a>`;
        }
    );

    return html;
}
