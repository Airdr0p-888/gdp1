import "./mint.js?v=20260623-connected-state";

const walletAddress = document.getElementById("walletAddress");
const networkName = document.getElementById("networkName");
const connectButton = document.getElementById("connectWallet");

const TEXT = {
  disconnected: "\u672a\u8fde\u63a5",
  unknown: "\u672a\u77e5",
  connected: "\u5df2\u8fde\u63a5"
};

function providerFromInjected() {
  const eth = window.ethereum;
  if (!eth) return null;
  if (Array.isArray(eth.providers)) {
    return eth.providers.find((provider) => provider.isTokenPocket)
      || eth.providers.find((provider) => provider.isMetaMask)
      || eth.providers[0];
  }
  return eth;
}

function isAddress(value) {
  return /^0x[a-fA-F0-9]{40}$/.test(String(value || "").trim());
}

function setConnected(address) {
  if (!isAddress(address) || !connectButton) return;
  if (walletAddress) walletAddress.textContent = address;
  connectButton.textContent = TEXT.connected;
  connectButton.classList.add("connected");
  connectButton.disabled = true;
}

async function readConnectedAccount() {
  const provider = providerFromInjected();
  if (!provider?.request) return false;
  try {
    const accounts = await provider.request({ method: "eth_accounts" });
    const account = accounts?.[0] || provider.selectedAddress;
    if (!isAddress(account)) return false;
    setConnected(account);
    await readNetwork(provider);
    return true;
  } catch {
    return false;
  }
}

async function readNetwork(provider) {
  if (!networkName || !provider?.request) return;
  const current = (networkName.textContent || "").trim();
  if (current && current !== TEXT.unknown) return;
  try {
    const chainIdHex = await provider.request({ method: "eth_chainId" });
    const chainId = Number.parseInt(chainIdHex, 16);
    networkName.textContent = chainId === 56
      ? "BNB Smart Chain"
      : chainId === 97
        ? "BNB Smart Chain Testnet"
        : `Chain ${chainId}`;
  } catch {}
}

function syncFromWalletText() {
  const value = (walletAddress?.textContent || "").trim();
  if (isAddress(value)) setConnected(value);
}

function watchAfterClick() {
  const started = Date.now();
  const timer = window.setInterval(async () => {
    syncFromWalletText();
    const done = await readConnectedAccount();
    if (done || Date.now() - started > 20000) window.clearInterval(timer);
  }, 700);
}

syncFromWalletText();
readConnectedAccount();

if (walletAddress) {
  new MutationObserver(syncFromWalletText).observe(walletAddress, {
    childList: true,
    characterData: true,
    subtree: true
  });
}

connectButton?.addEventListener("click", () => {
  window.setTimeout(watchAfterClick, 400);
});

window.ethereum?.on?.("accountsChanged", (accounts) => {
  if (isAddress(accounts?.[0])) setConnected(accounts[0]);
});
