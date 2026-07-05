// ── TMT Native — Chat Reader Configuration ────────────────────────────────────
//
// HOW TO FIND SELECTORS
// ─────────────────────
// 1. Launch TMT Native and press F11 — this opens DevTools for the hidden
//    Stripchat chat-reader view (the public room, not the broadcast centre).
// 2. Go live so chat messages appear, then switch to the Elements tab.
// 3. Inspect one message row → walk UP the DOM until you find the scrolling
//    container that holds all rows.
// 4. Right-click that element → Copy → Copy selector.
//    Paste it into "container" below.
// 5. Do the same for a single message row → "message".
// 6. Inside a message row, find the username element → "username".
// 7. Find the message-text element → "text".
//
// querySelector accepts comma-separated fallbacks, e.g.:
//   container: '[class*="Messages"], ul.chat-list'
// The first matching element wins, so put the most-specific selector first.
// ─────────────────────────────────────────────────────────────────────────────

module.exports = {
  // Local WebSocket server port — OBS browser sources connect to ws://localhost:<wsPort>
  wsPort: 8765,

  platforms: [
    {
      id:        'stripchat',
      name:      'Stripchat',
      enabled:   false,  // chat is read directly from scView (broadcast view) in main.js

      // Room URL is derived dynamically from the Stripchat destination's username;
      // this value is unused (platform is disabled, chat is read from scView in main.js).
      roomUrl:   '',
      partition: 'persist:stripchat',

      selectors: {
        // Confirmed via DevTools inspection of stripchat.com/juicyxi.
        // .messages is the direct parent of message divs inside the wrapper.
        container: '.model-chat-messages-wrapper .messages, .model-chat-messages-wrapper',

        // Each message row has data-message-id and class "message message-base".
        message:   '[data-message-id], .message.message-base, .regular-message',

        username:  '.user-chat-name, [class*="username" i], [class*="user-name" i], [class*="nick" i], [class*="author" i]',

        text:      '[class*="message-text" i], [class*="msg-text" i], [class*="content" i], p',
      },
    },

    {
      id:        'bongacams',
      name:      'BongaCams',
      enabled:   false,                            // set to true when you need it

      roomUrl:   'https://bongacams.com/YOUR_USERNAME',
      partition: 'persist:chat-bongacams',

      selectors: {
        // BongaCams uses a more stable DOM — still verify via DevTools first run.
        container: '#chat-items, .chat-items-list',
        message:   '.chat-item-message, .cams-chat__message',
        username:  '.chat-message-sender, .cams-chat__username',
        text:      '.chat-message-text, .cams-chat__text',
      },
    },
  ],
};
