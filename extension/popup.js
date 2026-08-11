// popup.js
const PORT = 3847;
const statusEl = document.getElementById("status");
const clearBtn = document.getElementById("clearBtn");

function checkServer() {
  fetch(`http://localhost:${PORT}/api/health`)
    .then((r) => r.json())
    .then(() => {
      statusEl.textContent = "Server: connected";
      statusEl.className = "status ok";
    })
    .catch(() => {
      statusEl.textContent = "Server: not running";
      statusEl.className = "status err";
    });
}

clearBtn.addEventListener("click", () => {
  fetch(`http://localhost:${PORT}/api/annotations`, { method: "DELETE" })
    .then((r) => r.json())
    .then(() => {
      chrome.runtime.sendMessage({ type: "badge-update", count: 0 });
      statusEl.textContent = "Cleared";
      statusEl.className = "status ok";
    })
    .catch(() => {
      statusEl.textContent = "Failed to clear";
      statusEl.className = "status err";
    });
});

checkServer();
