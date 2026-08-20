/**
 * A tiny, self-contained Snake game. DOM/canvas only, no deps.
 *
 * Two hosts today, with different key-capture needs:
 *   - the Cmd+K "Play Snake" modal, which owns the whole screen and can take
 *     every arrow/WASD press ({ keyScope: "document" }, the default);
 *   - the while-Claude-is-working popup (electron/preload.js), which floats
 *     over a live page whose composer is still typeable — capturing WASD on
 *     document there would eat the user's own typing, so it passes
 *     { keyScope: "element" } and only steers once the board itself is
 *     focused (click or Tab onto it).
 */

const GRID_SIZE = 18;
const CELL_PX = 16;
const TICK_MS = 120;

const KEY_MAP = {
  ArrowUp: { x: 0, y: -1 }, w: { x: 0, y: -1 }, W: { x: 0, y: -1 },
  ArrowDown: { x: 0, y: 1 }, s: { x: 0, y: 1 }, S: { x: 0, y: 1 },
  ArrowLeft: { x: -1, y: 0 }, a: { x: -1, y: 0 }, A: { x: -1, y: 0 },
  ArrowRight: { x: 1, y: 0 }, d: { x: 1, y: 0 }, D: { x: 1, y: 0 },
};

function mountSnakeGame(container, { keyScope = "document" } = {}) {
  container.innerHTML = "";
  const wrap = document.createElement("div");
  wrap.className = "bc-snake-wrap";
  // Element scope needs a focusable host to receive keydown at all. -1 keeps
  // it out of the page's Tab order (this popup is opt-in entertainment, not a
  // step on the way to the composer) while still accepting a click-to-focus.
  if (keyScope === "element") wrap.tabIndex = -1;

  const scoreEl = document.createElement("div");
  scoreEl.className = "bc-snake-score";
  scoreEl.textContent = "Score: 0";

  const canvas = document.createElement("canvas");
  canvas.width = GRID_SIZE * CELL_PX;
  canvas.height = GRID_SIZE * CELL_PX;
  canvas.className = "bc-snake-canvas";

  const hint = document.createElement("div");
  hint.className = "bc-snake-hint";
  hint.textContent = keyScope === "element"
    ? "Click the board, then arrow keys or WASD."
    : "Arrow keys or WASD to move.";

  wrap.appendChild(scoreEl);
  wrap.appendChild(canvas);
  wrap.appendChild(hint);
  container.appendChild(wrap);

  const ctx = canvas.getContext("2d");
  let snake, dir, nextDir, food, score, gameOver;

  function randomFood() {
    let pos;
    do {
      pos = { x: Math.floor(Math.random() * GRID_SIZE), y: Math.floor(Math.random() * GRID_SIZE) };
    } while (snake.some((s) => s.x === pos.x && s.y === pos.y));
    return pos;
  }

  function reset() {
    snake = [{ x: 9, y: 9 }, { x: 8, y: 9 }, { x: 7, y: 9 }];
    dir = { x: 1, y: 0 };
    nextDir = dir;
    food = randomFood();
    score = 0;
    gameOver = false;
    scoreEl.textContent = "Score: 0";
  }

  function onKeydown(e) {
    const next = KEY_MAP[e.key];
    if (next && !(next.x === -dir.x && next.y === -dir.y)) {
      nextDir = next;
      e.preventDefault();
    }
    if (gameOver && e.key === "Enter") reset();
  }
  const keyTarget = keyScope === "element" ? wrap : document;
  keyTarget.addEventListener("keydown", onKeydown);
  // Clicking the canvas is the natural "I want to play now" gesture; without
  // this the element-scoped listener would never fire (a <canvas> isn't
  // focusable, so the click alone leaves focus wherever it already was).
  if (keyScope === "element") canvas.addEventListener("mousedown", () => wrap.focus());

  function tick() {
    if (gameOver) return;
    dir = nextDir;
    const head = { x: snake[0].x + dir.x, y: snake[0].y + dir.y };
    const hitWall = head.x < 0 || head.y < 0 || head.x >= GRID_SIZE || head.y >= GRID_SIZE;
    const hitSelf = snake.some((s) => s.x === head.x && s.y === head.y);
    if (hitWall || hitSelf) {
      gameOver = true;
      draw();
      return;
    }
    snake.unshift(head);
    if (head.x === food.x && head.y === food.y) {
      score += 1;
      scoreEl.textContent = `Score: ${score}`;
      food = randomFood();
    } else {
      snake.pop();
    }
    draw();
  }

  function draw() {
    ctx.fillStyle = "#14101f";
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.fillStyle = "#f5c518";
    ctx.fillRect(food.x * CELL_PX + 1, food.y * CELL_PX + 1, CELL_PX - 2, CELL_PX - 2);
    snake.forEach((seg, i) => {
      ctx.fillStyle = i === 0 ? "#8b5cf6" : "#6d3fd1";
      ctx.fillRect(seg.x * CELL_PX + 1, seg.y * CELL_PX + 1, CELL_PX - 2, CELL_PX - 2);
    });
    if (gameOver) {
      ctx.fillStyle = "rgba(0,0,0,0.6)";
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      ctx.fillStyle = "#ece7fb";
      ctx.font = "14px -apple-system, sans-serif";
      ctx.textAlign = "center";
      ctx.fillText("Game Over", canvas.width / 2, canvas.height / 2 - 8);
      ctx.fillText("Enter to retry", canvas.width / 2, canvas.height / 2 + 12);
    }
  }

  reset();
  draw();
  const interval = setInterval(tick, TICK_MS);

  return {
    destroy() {
      clearInterval(interval);
      keyTarget.removeEventListener("keydown", onKeydown);
      container.innerHTML = "";
    },
  };
}

module.exports = { mountSnakeGame };
