import { ethers } from "https://cdn.jsdelivr.net/npm/ethers@6.13.5/dist/ethers.min.js";

const TOKEN_ABI = [
  "function name() view returns (string)",
  "function symbol() view returns (string)",
  "function decimals() view returns (uint8)",
  "function balanceOf(address) view returns (uint256)",
  "function mintMode() view returns (uint8)",
  "function usdtAddress() view returns (address)",
  "function mintPrice() view returns (uint256)",
  "function tokenPerMint() view returns (uint256)",
  "function mintedCount() view returns (uint256)",
  "function maxMintCount() view returns (uint256)",
  "function mintEnabled() view returns (bool)",
  "function hasMinted(address) view returns (bool)",
  "function whitelistEnabled() view returns (bool)",
  "function whitelist(address) view returns (bool)",
  "function pendingTokenDividend(address) view returns (uint256)",
  "function pendingLPDividend(address) view returns (uint256)",
  "function dividendReserve() view returns (uint256)",
  "function minTokenDividendBalance() view returns (uint256)",
  "function mintBNB() payable",
  "function mintUSDT()",
  "function claimDividends()"
];

const ERC20_ABI = [
  "function symbol() view returns (string)",
  "function decimals() view returns (uint8)",
  "function balanceOf(address) view returns (uint256)",
  "function allowance(address,address) view returns (uint256)",
  "function approve(address,uint256) returns (bool)"
];

const NETWORKS = {
  56: { name: "BNB Smart Chain", native: "BNB" },
  97: { name: "BNB Smart Chain Testnet", native: "tBNB" }
};

const state = {
  provider: null,
  signer: null,
  account: null,
  contract: null,
  tokenDecimals: 18,
  rewardDecimals: 18,
  rewardSymbol: "BNB",
  nativeSymbol: "BNB",
  mode: 0
};

const $ = (id) => document.getElementById(id);
const short = (addr) => addr ? `${addr.slice(0, 6)}...${addr.slice(-4)}` : "-";
const isAddress = (addr) => ethers.isAddress(String(addr || "").trim());

function log(message) {
  $("log").textContent = `[${new Date().toLocaleTimeString()}] ${message}\n` + $("log").textContent;
}

function providerFromWallet() {
  const eth = window.ethereum;
  if (!eth) throw new Error("没有检测到钱包，请先安装 MetaMask 或 TokenPocket。");
  if (Array.isArray(eth.providers)) {
    return eth.providers.find((p) => p.isTokenPocket) || eth.providers.find((p) => p.isMetaMask) || eth.providers[0];
  }
  return eth;
}

async function connectWallet() {
  const injected = providerFromWallet();
  state.provider = new ethers.BrowserProvider(injected);
  await injected.request({ method: "eth_requestAccounts" });
  state.signer = await state.provider.getSigner();
  state.account = await state.signer.getAddress();
  const network = await state.provider.getNetwork();
  const chainId = Number(network.chainId);
  state.nativeSymbol = NETWORKS[chainId]?.native || network.name || "BNB";
  $("walletAddress").textContent = state.account;
  $("networkName").textContent = NETWORKS[chainId]?.name || `Chain ${chainId}`;
  log(`钱包已连接：${short(state.account)}`);
}

async function ensureWallet() {
  if (!state.signer) await connectWallet();
}

function formatAmount(value, decimals = 18, max = 6) {
  const text = ethers.formatUnits(value, decimals);
  if (!text.includes(".")) return text;
  const [whole, frac] = text.split(".");
  const trimmed = frac.slice(0, max).replace(/0+$/, "");
  return trimmed ? `${whole}.${trimmed}` : whole;
}

function renderStats(id, items) {
  $(id).innerHTML = items.map(([label, value]) => (
    `<div class="stat"><span>${label}</span><strong>${value}</strong></div>`
  )).join("");
}

async function txDone(tx, label) {
  log(`${label} 已提交：${tx.hash}`);
  await tx.wait();
  log(`${label} 已确认`);
}

async function approveIfNeeded(tokenAddress, spender, amount, label) {
  const token = new ethers.Contract(tokenAddress, ERC20_ABI, state.signer);
  const allowance = await token.allowance(state.account, spender);
  if (allowance >= amount) return;
  await txDone(await token.approve(spender, amount), `${label} 授权`);
}

async function loadContract() {
  await ensureWallet();
  const address = $("contractAddress").value.trim();
  if (!isAddress(address)) throw new Error("请填写正确的合约地址。");
  localStorage.setItem("modaMintContract", address);
  const url = new URL(location.href);
  url.searchParams.set("contract", address);
  history.replaceState(null, "", url);
  state.contract = new ethers.Contract(address, TOKEN_ABI, state.signer);
  await refreshContract();
  log(`合约已读取：${address}`);
}

async function refreshContract() {
  if (!state.contract) return;
  const [
    name,
    symbol,
    decimals,
    balance,
    mode,
    mintPrice,
    tokenPerMint,
    mintedCount,
    maxMintCount,
    mintEnabled,
    hasMinted,
    whitelistEnabled,
    pendingToken,
    pendingLP,
    dividendReserve,
    minTokenDividendBalance
  ] = await Promise.all([
    state.contract.name(),
    state.contract.symbol(),
    state.contract.decimals(),
    state.contract.balanceOf(state.account),
    state.contract.mintMode(),
    state.contract.mintPrice(),
    state.contract.tokenPerMint(),
    state.contract.mintedCount(),
    state.contract.maxMintCount(),
    state.contract.mintEnabled(),
    state.contract.hasMinted(state.account),
    state.contract.whitelistEnabled(),
    state.contract.pendingTokenDividend(state.account),
    state.contract.pendingLPDividend(state.account),
    state.contract.dividendReserve(),
    state.contract.minTokenDividendBalance()
  ]);

  state.tokenDecimals = Number(decimals);
  state.mode = Number(mode);
  state.rewardSymbol = state.mode === 0 ? state.nativeSymbol : "USDT";
  state.rewardDecimals = 18;

  let whitelistStatus = "未开启";
  if (whitelistEnabled) {
    const allowed = await state.contract.whitelist(state.account);
    whitelistStatus = allowed ? "已在白名单" : "未在白名单";
  }

  if (state.mode === 1) {
    const usdt = await state.contract.usdtAddress();
    const reward = new ethers.Contract(usdt, ERC20_ABI, state.signer);
    try {
      state.rewardSymbol = await reward.symbol();
      state.rewardDecimals = Number(await reward.decimals());
    } catch {
      state.rewardSymbol = "USDT";
      state.rewardDecimals = 18;
    }
  }

  $("tokenTitle").textContent = `${name} (${symbol})`;
  $("mintModeBadge").textContent = state.mode === 0 ? "BNB" : "USDT";
  $("rewardUnitBadge").textContent = state.rewardSymbol;

  renderStats("mintStats", [
    ["Mint 价格", `${formatAmount(mintPrice, state.rewardDecimals)} ${state.rewardSymbol}`],
    ["单次获得", `${formatAmount(tokenPerMint, state.tokenDecimals)} ${symbol}`],
    ["Mint 进度", `${mintedCount.toString()} / ${maxMintCount.toString()}`],
    ["Mint 状态", mintEnabled ? "开启" : "关闭"],
    ["我的余额", `${formatAmount(balance, state.tokenDecimals)} ${symbol}`],
    ["我的资格", hasMinted ? "已 Mint" : whitelistStatus]
  ]);

  renderStats("rewardStats", [
    ["持币可领", `${formatAmount(pendingToken, state.rewardDecimals)} ${state.rewardSymbol}`],
    ["LP 可领", `${formatAmount(pendingLP, state.rewardDecimals)} ${state.rewardSymbol}`],
    ["分红储备", `${formatAmount(dividendReserve, state.rewardDecimals)} ${state.rewardSymbol}`],
    ["最低持仓", `${formatAmount(minTokenDividendBalance, state.tokenDecimals)} ${symbol}`]
  ]);
}

async function mintNow() {
  await ensureWallet();
  if (!state.contract) await loadContract();
  const address = await state.contract.getAddress();
  const mode = Number(await state.contract.mintMode());
  const price = await state.contract.mintPrice();
  if (mode === 0) {
    await txDone(await state.contract.mintBNB({ value: price }), "Mint");
  } else {
    const usdt = await state.contract.usdtAddress();
    const token = new ethers.Contract(usdt, ERC20_ABI, state.signer);
    const balance = await token.balanceOf(state.account);
    if (balance < price) throw new Error(`USDT 余额不足，需要 ${formatAmount(price, state.rewardDecimals)} ${state.rewardSymbol}`);
    await approveIfNeeded(usdt, address, price, "USDT Mint");
    await txDone(await state.contract.mintUSDT(), "Mint");
  }
  await refreshContract();
}

async function claimDividends() {
  await ensureWallet();
  if (!state.contract) await loadContract();
  await txDone(await state.contract.claimDividends(), "领取分红");
  await refreshContract();
}

async function run(button, fn) {
  try {
    button.disabled = true;
    await fn();
  } catch (err) {
    console.error(err);
    const message = err.shortMessage || err.reason || err.message || String(err);
    if (message.includes("TRANSFER_FROM_FAILED")) {
      log("TRANSFER_FROM_FAILED：通常是授权不足、余额不足、USDT/Router/网络不匹配，或池子太浅导致路由失败。");
    } else if (message.includes("insufficient funds")) {
      log("Gas 不足：请确认当前网络的钱包里有足够原生币支付手续费。");
    } else {
      log(message);
    }
  } finally {
    button.disabled = false;
  }
}

function bootAddress() {
  const params = new URLSearchParams(location.search);
  const fromUrl = params.get("contract");
  const saved = localStorage.getItem("modaMintContract");
  const address = isAddress(fromUrl) ? fromUrl : saved;
  if (address) $("contractAddress").value = address;
}

$("connectWallet").addEventListener("click", (event) => run(event.currentTarget, async () => {
  await connectWallet();
  if (isAddress($("contractAddress").value)) await loadContract();
}));
$("loadContract").addEventListener("click", (event) => run(event.currentTarget, loadContract));
$("mintNow").addEventListener("click", (event) => run(event.currentTarget, mintNow));
$("claimDividends").addEventListener("click", (event) => run(event.currentTarget, claimDividends));

window.ethereum?.on?.("accountsChanged", () => {
  state.signer = null;
  state.account = null;
  connectWallet().then(async () => {
    if (isAddress($("contractAddress").value)) await loadContract();
  }).catch((err) => log(err.message || String(err)));
});

window.ethereum?.on?.("chainChanged", () => location.reload());

bootAddress();
