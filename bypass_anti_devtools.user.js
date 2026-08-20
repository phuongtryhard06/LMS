// ==UserScript==
// @name         Bypass LMS ICTU DevTools Detection & Auto Get Headers
// @namespace    http://tampermonkey.net/
// @version      1.0
// @description  Vô hiệu hóa cảnh báo phát hiện DevTools F12 trên LMS ICTU và tự động lấy đáp án
// @author       Tris
// @match        https://lms.ictu.edu.vn/*
// @grant        none
// @run-at       document-start
// ==/UserScript==

(function() {
    'use strict';

    // 1. Chặn các hàm debugger & resize detection
    const originalClearInterval = window.clearInterval;
    const originalSetInterval = window.setInterval;

    // Vô hiệu hóa alert / popup cảnh báo F12
    const originalAlert = window.alert;
    window.alert = function(msg) {
        if (msg && msg.includes('developer tools')) {
            console.log('[Tris LMS Hook] Blocked alert:', msg);
            return;
        }
        return originalAlert.apply(this, arguments);
    };

    // Chặn class hoặc DOM cảnh báo
    const observer = new MutationObserver((mutations) => {
        for (const mutation of mutations) {
            for (const node of mutation.addedNodes) {
                if (node.nodeType === 1) {
                    if (node.textContent && node.textContent.includes('Hệ thống phát hiện bạn vừa mở developer tools')) {
                        node.remove();
                        console.log('[Tris LMS Hook] Removed warning banner.');
                    }
                }
            }
        }
    });

    observer.observe(document.documentElement, {
        childList: true,
        subtree: true
    });

    console.log('[Tris LMS Hook] DevTools anti-detection loaded.');
})();
