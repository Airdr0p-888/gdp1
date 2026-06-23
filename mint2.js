import "./mint.js?v=20260623-connected-state";

const walletAddress = document.getElementById("walletAddress");
const connectButton = document.getElementById("connectWallet");

function syncConnectedButton() {
  const value = (walletAddress?.textContent || "").trim();
  const connected = value && value !== "未连接" && value !== "鏈繛鎺?";
  if (!connected || !connectButton) return;
  connectButton.textContent = "已连接";
  connectButton.classList.add("connected");
  connectButton.disabled = true;
}

syncConnectedButton();

if (walletAddress) {
  new MutationObserver(syncConnectedButton).observe(walletAddress, {
    childList: true,
    characterData: true,
    subtree: true
  });
}

connectButton?.addEventListener("click", () => {
  setTimeout(syncConnectedButton, 800);
});
