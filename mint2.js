import "./mint.js?v=20260623-connected-state";

const walletAddress = document.getElementById("walletAddress");
const networkName = document.getElementById("networkName");
const connectButton = document.getElementById("connectWallet");

const disconnectedLabels = new Set(["", "未连接", "鏈繛鎺?", "未知", "鏈煡"]);

function injectedProvider() {
  const eth = window.ethereum;
  if (!eth) return null;
  if (Array.isArray(eth.providers)) {
    return eth.providers.find((provider) => provider.isTokenPocket)
      || eth.providers.find((provider) => provider.isMetaMask)
      || eth.providers[0];
  }
  return eth;
}

function isWalletAddress(value) {
  return /^0x[a-fA-F0-9]{40}$/.test(String(value || "").trim());
}

function markConnected(address) {
  if (!isWalletAddress(address)) return;
  if (walletAddress) walletAddress.textContent = address;
  if (!connectButton) return;
  connectButton.textContent = "已连接";
  connectButton.classList.add("connected");
  connectButton.disabled = true;
}

function syncConnectedButton() {
  const value = (walletAddress?.textContent || "").trim();
  if (isWalletAddress(value)) markConnected(value);
}

async function syncFromInjectedWallet() {
  const provider = injectedProvider();
  if (!provider?.request) return false;
  let accounts = [];
  try {
    accounts = await provider.request({ method: "eth_accounts" });
  } catch {
    return false;
  }
  const account = accounts?.[0] || provider.selectedAddress;
  if (!isWalletAddress(account)) return false;
  markConnected(account);
  try {
    const chainIdHex = await provider.request({ method: "eth_chainId" });
    const chainId = Number.parseInt(chainIdHex, 16);
    const currentNetwork = (networkName?.textContent || "").trim();
    if (networkName && disconnectedLabels.has(currentNetwork)) {
      networkName.textContent = chainId === 56 ? "BNB Smart Chain" : chainId === 97 ? "BNB Smart Chain Testnet" : `Chain ${chainId}`;
    }
  } catch {}
  return true;
}

function watchWalletFor(ms = 15000) {
  const started = Date.now();
  const timer = window.setInterval(async () => {
    syncConnectedButton();
    const synced = await syncFromInjectedWallet();
    if (synced || Date.now() - started > ms) window.clearInterval(timer);
  }, 500);
}

syncConnectedButton();
syncFromInjectedWallet();

if (walletAddress) {
  new MutationObserver(syncConnectedButton).observe(walletAddress, {
    childList: true,
    characterData: true,
    subtree: true
  });
}

connectButton?.addEventListener("click", () => {
  window.setTimeout(() => watchWalletFor(20000), 300);
});

window.ethereum?.on?.("accountsChanged", (accounts) => {
  if (isWalletAddress(accounts?.[0])) markConnected(accounts[0]);
});
