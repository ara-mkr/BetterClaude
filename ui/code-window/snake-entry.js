/**
 * Page-world bundle entry for BetterClaude's Code windows.
 *
 * Both code-window.html and ide-window.html run with nodeIntegration off, so
 * ui/mini-game/snake.js (CommonJS) and the waiting-snake wrapper cannot be
 * require()d there — they arrive as this IIFE global instead, the same way
 * xterm does via build/xterm.bundle.js.
 */
const { mountSnakeGame } = require("../mini-game/snake");
const { createWaitingSnake } = require("./waiting-snake");

module.exports = { mountSnakeGame, createWaitingSnake };
