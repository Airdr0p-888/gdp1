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

function shortAddress(address) {
  return `${address.slice(0, 6)}...${address.slice(-4)}`;
}

function markConnected(address) {
  if (walletAddress && address && !disconnectedLabels.has((walletAddress.textContent || "").trim())) {
    address = walletAddress.textContent.trim();
  }
  if (walletAddress && address) walletAddress.textContent = address;
  if (connectButton) {
    connectButton.textContent = "已连接";
    connectButton.classList.add("connected");
    connectButton.disabled = true;
  }
}

function syncConnectedButton() {
  const value = (walletAddress?.textContent || "").trim();
  const connected = value && !disconnectedLabels.has(value);
  if (!connected || !connectButton) return;
  markConnected(value);
}

async function syncFromInjectedWallet(requestPermission = false) {
  const provider = injectedProvider();
  if (!provider?.request) return false;
  let accounts = [];
  try {
    accounts = await provider.request({ method: "eth_accounts" });
    if ((!accounts || accounts.length === 0) && requestPermission) {
      accounts = await provider.request({ method: "eth_requestAccounts" });
    }
  } catch {
    return false;
  }
  const account = accounts?.[0] || provider.selectedAddress;
  if (!account) return false;
  markConnected(account);
  try {
    const chainIdHex = await provider.request({ method: "eth_chainId" });
    const chainId = Number.parseInt(chainIdHex, 16);
    if (networkName && disconnectedLabels.has((networkName.textContent || "").trim())) {
      networkName.textContent = chainId === 56 ? "BNB Smart Chain" : chainId === 97 ? "BNB Smart Chain Testnet" : `Chain ${chainId}`;
    }
  } catch {}
  return true;
}

function watchWalletFor(ms = 15000) {
  const started = Date.now();
  const timer = window.setInterval(async () => {
    syncConnectedButton();
    const synced = await syncFromInjectedWallet(false);
    if (synced || Date.now() - started > ms) window.clearInterval(timer);
  }, 500);
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
  watchWalletFor(20000);
});

window.addEventListener("load", () => {
  watchWalletFor(12000);
  setTimeout(() => syncFromInjectedWallet(true), 800);
});

window.ethereum?.on?.("accountsChanged", (accounts) => {
  if (accounts?.[0]) markConnected(accounts[0]);
});

watchWalletFor(12000);
