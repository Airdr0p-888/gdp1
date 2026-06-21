import { ethers } from "https://cdn.jsdelivr.net/npm/ethers@6.13.5/dist/ethers.min.js";
import solc from "https://esm.sh/solc@0.8.24";

const CONTRACT_SOURCE = String.raw`// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/security/Pausable.sol";
import "@openzeppelin/contracts/security/ReentrancyGuard.sol";

interface IPancakeRouterV2 {
    function factory() external pure returns (address);
    function WETH() external pure returns (address);
    function addLiquidityETH(address token,uint amountTokenDesired,uint amountTokenMin,uint amountETHMin,address to,uint deadline) external payable returns (uint amountToken, uint amountETH, uint liquidity);
    function addLiquidity(address tokenA,address tokenB,uint amountADesired,uint amountBDesired,uint amountAMin,uint amountBMin,address to,uint deadline) external returns (uint amountA, uint amountB, uint liquidity);
    function swapExactTokensForETHSupportingFeeOnTransferTokens(uint amountIn,uint amountOutMin,address[] calldata path,address to,uint deadline) external;
    function swapExactTokensForTokensSupportingFeeOnTransferTokens(uint amountIn,uint amountOutMin,address[] calldata path,address to,uint deadline) external;
}

interface IPancakeFactoryV2 {
    function createPair(address tokenA, address tokenB) external returns (address pair);
}

contract ModaFairMintTokenV1 is ERC20, Ownable, Pausable, ReentrancyGuard {
    using SafeERC20 for IERC20;
    enum MintMode { BNB, USDT }
    enum LaunchMode { MANUAL, TIME, AUTO }
    uint256 public constant DENOMINATOR = 10000;
    uint256 public constant MAX_TAX = 1000;
    MintMode public mintMode;
    LaunchMode public launchMode;
    address public usdtAddress;
    IPancakeRouterV2 public router;
    address public pair;
    uint256 public mintPrice;
    uint256 public tokenPerMint;
    uint256 public maxMintCount;
    uint256 public mintedCount;
    uint256 public userMintShare;
    uint256 public lpFundShare;
    uint256 public launchTime;
    bool public mintEnabled = true;
    bool public tradingOpen;
    mapping(address => bool) public hasMinted;
    bool public whitelistEnabled;
    mapping(address => bool) public whitelist;
    mapping(address => bool) public blacklist;
    mapping(address => bool) public isExcludedFromLimits;
    mapping(address => bool) public isExcludedFromFee;
    uint256 public buyTax;
    uint256 public sellTax;
    uint256 public transferTax;
    uint256 public marketingShare;
    uint256 public burnShare;
    uint256 public lpShare;
    address public marketingWallet;
    address public deadWallet;
    bool public swapEnabled = true;
    bool private inSwap;
    uint256 public swapThreshold;
    uint256 public tokenDividendPerShare;
    uint256 public lpDividendPerShare;
    uint256 private constant ACC = 1e36;
    mapping(address => uint256) public tokenDividendDebt;
    mapping(address => uint256) public lpDividendDebt;
    mapping(address => uint256) public lpBalanceSnapshot;
    event Minted(address indexed user, uint256 paidAmount, uint256 userTokens, uint256 lpTokens, uint256 lpFund);
    event TradingOpened(uint256 timestamp);
    event SwapBack(uint256 tokenAmount, uint256 receivedAmount);
    event TokenDividendFunded(uint256 amount);
    event LPDividendFunded(uint256 amount);
    event DividendClaimed(address indexed user, uint256 tokenReward, uint256 lpReward);
    modifier lockSwap() { inSwap = true; _; inSwap = false; }
    constructor(string memory name_, string memory symbol_, uint256 totalSupply_, MintMode mintMode_, address usdtAddress_, address router_, uint256 mintPrice_, uint256 tokenPerMint_, uint256 maxMintCount_, uint256 userMintShare_, uint256 lpFundShare_, LaunchMode launchMode_, uint256 launchTime_, address marketingWallet_) ERC20(name_, symbol_) Ownable(msg.sender) {
        require(totalSupply_ > 0, "totalSupply zero");
        require(router_ != address(0), "router zero");
        require(marketingWallet_ != address(0), "marketing zero");
        require(userMintShare_ <= DENOMINATOR, "bad user share");
        require(lpFundShare_ <= DENOMINATOR, "bad lp fund share");
        if (mintMode_ == MintMode.USDT) require(usdtAddress_ != address(0), "usdt zero");
        if (launchMode_ == LaunchMode.TIME) require(launchTime_ > block.timestamp, "bad launch time");
        mintMode = mintMode_;
        usdtAddress = usdtAddress_;
        router = IPancakeRouterV2(router_);
        mintPrice = mintPrice_;
        tokenPerMint = tokenPerMint_;
        maxMintCount = maxMintCount_;
        userMintShare = userMintShare_;
        lpFundShare = lpFundShare_;
        launchMode = launchMode_;
        launchTime = launchTime_;
        marketingWallet = marketingWallet_;
        deadWallet = 0x000000000000000000000000000000000000dEaD;
        address base = mintMode_ == MintMode.BNB ? router.WETH() : usdtAddress_;
        pair = IPancakeFactoryV2(router.factory()).createPair(address(this), base);
        _mint(address(this), totalSupply_);
        swapThreshold = totalSupply_ / 1000;
        isExcludedFromLimits[msg.sender] = true;
        isExcludedFromLimits[address(this)] = true;
        isExcludedFromLimits[router_] = true;
        isExcludedFromLimits[pair] = true;
        isExcludedFromFee[msg.sender] = true;
        isExcludedFromFee[address(this)] = true;
        isExcludedFromFee[router_] = true;
    }
    receive() external payable {}
    function decimals() public pure override returns (uint8) { return 18; }
    function mintBNB() external payable nonReentrant whenNotPaused { require(mintMode == MintMode.BNB, "not BNB mode"); require(msg.value == mintPrice, "bad BNB amount"); _mintFlow(msg.sender, msg.value); }
    function mintUSDT() external nonReentrant whenNotPaused { require(mintMode == MintMode.USDT, "not USDT mode"); IERC20(usdtAddress).safeTransferFrom(msg.sender, address(this), mintPrice); _mintFlow(msg.sender, mintPrice); }
    function _mintFlow(address user, uint256 paidAmount) internal {
        require(mintEnabled, "mint disabled"); require(!hasMinted[user], "already minted"); require(mintedCount < maxMintCount, "mint full"); require(!blacklist[user], "blacklisted"); if (whitelistEnabled) require(whitelist[user], "not whitelisted");
        hasMinted[user] = true; mintedCount += 1;
        uint256 userTokens = tokenPerMint * userMintShare / DENOMINATOR;
        uint256 lpTokens = tokenPerMint - userTokens;
        uint256 lpFund = paidAmount * lpFundShare / DENOMINATOR;
        require(balanceOf(address(this)) >= tokenPerMint, "insufficient token reserve");
        if (lpTokens > 0 && lpFund > 0) {
            _approve(address(this), address(router), lpTokens);
            if (mintMode == MintMode.BNB) router.addLiquidityETH{value: lpFund}(address(this), lpTokens, 0, 0, owner(), block.timestamp);
            else { IERC20(usdtAddress).forceApprove(address(router), lpFund); router.addLiquidity(address(this), usdtAddress, lpTokens, lpFund, 0, 0, owner(), block.timestamp); }
        }
        if (userTokens > 0) _transfer(address(this), user, userTokens);
        emit Minted(user, paidAmount, userTokens, lpTokens, lpFund);
        if (mintedCount >= maxMintCount) { mintEnabled = false; if (launchMode == LaunchMode.AUTO) _openTrading(); }
    }
    function _update(address from, address to, uint256 amount) internal override {
        if (from == address(0) || to == address(0)) { super._update(from, to, amount); return; }
        require(!blacklist[from] && !blacklist[to], "blacklisted");
        if (!tradingOpen && launchMode == LaunchMode.TIME && launchTime > 0 && block.timestamp >= launchTime) { tradingOpen = true; emit TradingOpened(block.timestamp); }
        bool exemptLimit = isExcludedFromLimits[from] || isExcludedFromLimits[to];
        if (!tradingOpen && !exemptLimit) revert("trading not open");
        if (!inSwap && swapEnabled && from != pair) { uint256 contractTokenBalance = balanceOf(address(this)); if (contractTokenBalance >= swapThreshold && swapThreshold > 0) _swapBack(contractTokenBalance); }
        uint256 taxAmount = 0;
        if (!inSwap && !isExcludedFromFee[from] && !isExcludedFromFee[to]) {
            uint256 taxRate; if (from == pair) taxRate = buyTax; else if (to == pair) taxRate = sellTax; else taxRate = transferTax;
            if (taxRate > 0) taxAmount = amount * taxRate / DENOMINATOR;
        }
        if (taxAmount > 0) { super._update(from, address(this), taxAmount); amount -= taxAmount; }
        _settleTokenDividend(from); _settleTokenDividend(to); super._update(from, to, amount);
    }
    function _openTrading() internal { if (!tradingOpen) { tradingOpen = true; mintEnabled = false; emit TradingOpened(block.timestamp); } }
    function openTrading() external onlyOwner { _openTrading(); }
    function closeMint() external onlyOwner { mintEnabled = false; }
    function _swapBack(uint256 tokenAmount) internal lockSwap {
        uint256 totalShare = marketingShare + burnShare + lpShare; if (totalShare == 0 || tokenAmount == 0) return;
        if (tokenAmount > swapThreshold * 20) tokenAmount = swapThreshold * 20;
        uint256 lpTokenHalf = tokenAmount * lpShare / totalShare / 2;
        uint256 tokensToSwap = tokenAmount - lpTokenHalf;
        uint256 beforeBal = _rewardBalance(); _approve(address(this), address(router), tokensToSwap);
        if (mintMode == MintMode.BNB) { address[] memory path = new address[](2); path[0] = address(this); path[1] = router.WETH(); router.swapExactTokensForETHSupportingFeeOnTransferTokens(tokensToSwap, 0, path, address(this), block.timestamp); }
        else { address[] memory path = new address[](2); path[0] = address(this); path[1] = usdtAddress; router.swapExactTokensForTokensSupportingFeeOnTransferTokens(tokensToSwap, 0, path, address(this), block.timestamp); }
        uint256 received = _rewardBalance() - beforeBal; if (received == 0) return;
        uint256 marketingAmt = received * marketingShare / totalShare; uint256 burnAmt = received * burnShare / totalShare; uint256 lpAmt = received - marketingAmt - burnAmt;
        _sendReward(marketingWallet, marketingAmt); _sendReward(deadWallet, burnAmt);
        if (lpAmt > 0 && lpTokenHalf > 0) { _approve(address(this), address(router), lpTokenHalf); if (mintMode == MintMode.BNB) router.addLiquidityETH{value: lpAmt}(address(this), lpTokenHalf, 0, 0, owner(), block.timestamp); else { IERC20(usdtAddress).forceApprove(address(router), lpAmt); router.addLiquidity(address(this), usdtAddress, lpTokenHalf, lpAmt, 0, 0, owner(), block.timestamp); } }
        emit SwapBack(tokenAmount, received);
    }
    function forceSwapBack() external onlyOwner { _swapBack(balanceOf(address(this))); }
    function forceAddLiquidity(uint256 tokenAmount, uint256 fundAmount) external payable onlyOwner nonReentrant lockSwap { require(tokenAmount > 0 && fundAmount > 0, "zero amount"); _approve(address(this), address(router), tokenAmount); if (mintMode == MintMode.BNB) { require(msg.value == fundAmount, "bad BNB"); router.addLiquidityETH{value: fundAmount}(address(this), tokenAmount, 0, 0, owner(), block.timestamp); } else { IERC20(usdtAddress).safeTransferFrom(msg.sender, address(this), fundAmount); IERC20(usdtAddress).forceApprove(address(router), fundAmount); router.addLiquidity(address(this), usdtAddress, tokenAmount, fundAmount, 0, 0, owner(), block.timestamp); } }
    function _rewardBalance() internal view returns (uint256) { return mintMode == MintMode.BNB ? address(this).balance : IERC20(usdtAddress).balanceOf(address(this)); }
    function _sendReward(address to, uint256 amount) internal { if (amount == 0) return; if (mintMode == MintMode.BNB) payable(to).transfer(amount); else IERC20(usdtAddress).safeTransfer(to, amount); }
    function fundTokenDividendBNB() external payable onlyOwner { require(mintMode == MintMode.BNB, "not BNB mode"); require(totalSupply() > balanceOf(address(this)), "no circulating supply"); tokenDividendPerShare += msg.value * ACC / (totalSupply() - balanceOf(address(this))); emit TokenDividendFunded(msg.value); }
    function fundTokenDividendUSDT(uint256 amount) external onlyOwner { require(mintMode == MintMode.USDT, "not USDT mode"); IERC20(usdtAddress).safeTransferFrom(msg.sender, address(this), amount); require(totalSupply() > balanceOf(address(this)), "no circulating supply"); tokenDividendPerShare += amount * ACC / (totalSupply() - balanceOf(address(this))); emit TokenDividendFunded(amount); }
    function fundLPDividendBNB() external payable onlyOwner { require(mintMode == MintMode.BNB, "not BNB mode"); uint256 lpSupply = IERC20(pair).totalSupply(); require(lpSupply > 0, "no lp supply"); lpDividendPerShare += msg.value * ACC / lpSupply; emit LPDividendFunded(msg.value); }
    function fundLPDividendUSDT(uint256 amount) external onlyOwner { require(mintMode == MintMode.USDT, "not USDT mode"); IERC20(usdtAddress).safeTransferFrom(msg.sender, address(this), amount); uint256 lpSupply = IERC20(pair).totalSupply(); require(lpSupply > 0, "no lp supply"); lpDividendPerShare += amount * ACC / lpSupply; emit LPDividendFunded(amount); }
    function claimDividends() external nonReentrant { uint256 tokenReward = pendingTokenDividend(msg.sender); uint256 lpReward = pendingLPDividend(msg.sender); tokenDividendDebt[msg.sender] = balanceOf(msg.sender) * tokenDividendPerShare / ACC; lpBalanceSnapshot[msg.sender] = IERC20(pair).balanceOf(msg.sender); lpDividendDebt[msg.sender] = lpBalanceSnapshot[msg.sender] * lpDividendPerShare / ACC; _sendReward(msg.sender, tokenReward + lpReward); emit DividendClaimed(msg.sender, tokenReward, lpReward); }
    function pendingTokenDividend(address user) public view returns (uint256) { uint256 accumulated = balanceOf(user) * tokenDividendPerShare / ACC; if (accumulated <= tokenDividendDebt[user]) return 0; return accumulated - tokenDividendDebt[user]; }
    function pendingLPDividend(address user) public view returns (uint256) { uint256 lpBal = IERC20(pair).balanceOf(user); uint256 accumulated = lpBal * lpDividendPerShare / ACC; if (accumulated <= lpDividendDebt[user]) return 0; return accumulated - lpDividendDebt[user]; }
    function syncLPDividendDebt() external { lpBalanceSnapshot[msg.sender] = IERC20(pair).balanceOf(msg.sender); lpDividendDebt[msg.sender] = lpBalanceSnapshot[msg.sender] * lpDividendPerShare / ACC; }
    function _settleTokenDividend(address user) internal { tokenDividendDebt[user] = balanceOf(user) * tokenDividendPerShare / ACC; }
    function setMintPrice(uint256 v) external onlyOwner { mintPrice = v; }
    function setTokenPerMint(uint256 v) external onlyOwner { tokenPerMint = v; }
    function setMaxMintCount(uint256 v) external onlyOwner { require(v >= mintedCount, "lt minted"); maxMintCount = v; }
    function setLaunchTime(uint256 v) external onlyOwner { launchTime = v; }
    function setWhitelistEnabled(bool v) external onlyOwner { whitelistEnabled = v; }
    function setWhitelist(address user, bool v) external onlyOwner { whitelist[user] = v; }
    function batchSetWhitelist(address[] calldata users, bool v) external onlyOwner { for (uint i; i < users.length; i++) whitelist[users[i]] = v; }
    function setBlacklist(address user, bool v) external onlyOwner { blacklist[user] = v; }
    function batchSetBlacklist(address[] calldata users, bool v) external onlyOwner { for (uint i; i < users.length; i++) blacklist[users[i]] = v; }
    function setExcludedFromLimits(address user, bool v) external onlyOwner { isExcludedFromLimits[user] = v; }
    function setExcludedFromFee(address user, bool v) external onlyOwner { isExcludedFromFee[user] = v; }
    function setBuyTax(uint256 v) external onlyOwner { require(v <= MAX_TAX, "tax > 10%"); buyTax = v; }
    function setSellTax(uint256 v) external onlyOwner { require(v <= MAX_TAX, "tax > 10%"); sellTax = v; }
    function setTransferTax(uint256 v) external onlyOwner { require(v <= MAX_TAX, "tax > 10%"); transferTax = v; }
    function setTaxShares(uint256 marketing, uint256 burn, uint256 lp) external onlyOwner { require(marketing + burn + lp == DENOMINATOR, "sum != 10000"); marketingShare = marketing; burnShare = burn; lpShare = lp; }
    function setMarketingShare(uint256 v) external onlyOwner { marketingShare = v; _checkShares(); }
    function setBurnShare(uint256 v) external onlyOwner { burnShare = v; _checkShares(); }
    function setLPShare(uint256 v) external onlyOwner { lpShare = v; _checkShares(); }
    function _checkShares() internal view { require(marketingShare + burnShare + lpShare == DENOMINATOR, "sum != 10000"); }
    function setMarketingWallet(address v) external onlyOwner { require(v != address(0), "zero"); marketingWallet = v; }
    function setDeadWallet(address v) external onlyOwner { require(v != address(0), "zero"); deadWallet = v; }
    function setSwapEnabled(bool v) external onlyOwner { swapEnabled = v; }
    function setSwapThreshold(uint256 v) external onlyOwner { swapThreshold = v; }
    function pause() external onlyOwner { _pause(); }
    function unpause() external onlyOwner { _unpause(); }
    function withdrawBNB(uint256 amount) external onlyOwner { payable(owner()).transfer(amount == 0 ? address(this).balance : amount); }
    function withdrawToken(address token, uint256 amount) external onlyOwner { IERC20 erc = IERC20(token); uint256 bal = erc.balanceOf(address(this)); erc.safeTransfer(owner(), amount == 0 ? bal : amount); }
    function withdrawLP(uint256 amount) external onlyOwner { IERC20 lpToken = IERC20(pair); uint256 bal = lpToken.balanceOf(address(this)); lpToken.safeTransfer(owner(), amount == 0 ? bal : amount); }
}`;

const ZERO = "0x0000000000000000000000000000000000000000";
const OPENZEPPELIN_BASE = "https://unpkg.com/@openzeppelin/contracts@5.0.2/";
const ERC20_ABI = [
  "function approve(address spender,uint256 amount) external returns (bool)",
  "function allowance(address owner,address spender) view returns (uint256)"
];
const CONSTRUCTOR_TYPES = [
  "string", "string", "uint256", "uint8", "address", "address", "uint256",
  "uint256", "uint256", "uint256", "uint256", "uint8", "uint256", "address"
];
const state = { provider: null, signer: null, account: null, compiled: null, admin: null, mint: null };

const $ = (id) => document.getElementById(id);
const log = (msg) => { $("log").textContent = `[${new Date().toLocaleTimeString()}] ${msg}\n` + $("log").textContent; };
const parseToken = (v) => ethers.parseUnits(String(v || "0"), 18);
const parseBool = (v) => v === true || v === "true";
const txDone = async (tx, label) => { log(`${label} 已提交：${tx.hash}`); await tx.wait(); log(`${label} 已确认`); };

async function approveIfNeeded(tokenAddress, spender, amount, label) {
  const token = new ethers.Contract(tokenAddress, ERC20_ABI, state.signer);
  const allowance = await token.allowance(state.account, spender);
  if (allowance >= amount) return;
  await txDone(await token.approve(spender, amount), `${label} 授权`);
}

function makeDownload(id, filename, content, type = "application/json") {
  const blob = new Blob([content], { type });
  const url = URL.createObjectURL(blob);
  const link = $(id);
  if (link.dataset.url) URL.revokeObjectURL(link.dataset.url);
  link.href = url;
  link.dataset.url = url;
  link.download = filename;
}

function jsonSafe(value) {
  return JSON.stringify(value, (_, item) => typeof item === "bigint" ? item.toString() : item, 2);
}

function setBusy(button, busy) {
  if (!button) return;
  button.disabled = busy;
}

async function connectWallet() {
  if (!window.ethereum) throw new Error("没有检测到浏览器钱包，请安装 MetaMask 或 OKX Wallet。");
  state.provider = new ethers.BrowserProvider(window.ethereum);
  await state.provider.send("eth_requestAccounts", []);
  state.signer = await state.provider.getSigner();
  state.account = await state.signer.getAddress();
  const network = await state.provider.getNetwork();
  $("walletAddress").textContent = state.account;
  $("networkName").textContent = `${network.name} / chainId ${network.chainId}`;
}

function normalizeImport(path) {
  if (path === "@openzeppelin/contracts/security/Pausable.sol") return "@openzeppelin/contracts/utils/Pausable.sol";
  if (path === "@openzeppelin/contracts/security/ReentrancyGuard.sol") return "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
  return path;
}

function resolveImport(importPath, fromPath) {
  const fixed = normalizeImport(importPath);
  if (fixed.startsWith("@openzeppelin/contracts/")) return fixed;
  if (fixed.startsWith("./") || fixed.startsWith("../")) {
    const base = fromPath.split("/").slice(0, -1);
    for (const part of fixed.split("/")) {
      if (part === "." || !part) continue;
      if (part === "..") base.pop();
      else base.push(part);
    }
    return normalizeImport(base.join("/"));
  }
  return fixed;
}

async function fetchSource(path, sources, seen) {
  if (seen.has(path)) return;
  seen.add(path);
  let content;
  if (path === "ModaFairMintTokenV1.sol") content = CONTRACT_SOURCE;
  else {
    const url = OPENZEPPELIN_BASE + path.replace("@openzeppelin/contracts/", "");
    const res = await fetch(url);
    if (!res.ok) throw new Error(`无法读取依赖：${path}`);
    content = await res.text();
  }
  sources[path] = { content };
  const imports = [...content.matchAll(/import\s+(?:[^"']+from\s+)?["']([^"']+)["'];/g)].map((m) => m[1]);
  for (const item of imports) await fetchSource(resolveImport(item, path), sources, seen);
}

async function compileContract() {
  log("开始准备编译依赖...");
  const sources = {};
  await fetchSource("ModaFairMintTokenV1.sol", sources, new Set());
  const input = {
    language: "Solidity",
    sources,
    settings: {
      optimizer: { enabled: true, runs: 200 },
      outputSelection: { "*": { "*": ["abi", "evm.bytecode.object"] } }
    }
  };
  const output = JSON.parse(solc.compile(JSON.stringify(input), {
    import: (path) => sources[normalizeImport(path)] || { error: `Missing import ${path}` }
  }));
  const errors = (output.errors || []).filter((e) => e.severity === "error");
  if (errors.length) throw new Error(errors.map((e) => e.formattedMessage).join("\n"));
  const contract = output.contracts["ModaFairMintTokenV1.sol"].ModaFairMintTokenV1;
  state.compiled = {
    abi: contract.abi,
    bytecode: "0x" + contract.evm.bytecode.object,
    standardJsonInput: input
  };
  log(`编译完成，ABI ${contract.abi.length} 项。`);
  return state.compiled;
}

function deployArgs(form) {
  const fd = new FormData(form);
  const launchRaw = fd.get("launchTime");
  const launchTime = launchRaw ? Math.floor(new Date(launchRaw).getTime() / 1000) : 0;
  return [
    fd.get("name"),
    fd.get("symbol"),
    parseToken(fd.get("totalSupply")),
    Number(fd.get("mintMode")),
    fd.get("usdtAddress") || ZERO,
    fd.get("router"),
    parseToken(fd.get("mintPrice")),
    parseToken(fd.get("tokenPerMint")),
    BigInt(fd.get("maxMintCount")),
    BigInt(fd.get("userMintShare")),
    BigInt(fd.get("lpFundShare")),
    Number(fd.get("launchMode")),
    BigInt(launchTime),
    fd.get("marketingWallet")
  ];
}

async function deployContract(ev) {
  ev.preventDefault();
  await ensureWallet();
  if (!state.compiled) await compileContract();
  const args = deployArgs(ev.currentTarget);
  log("请在钱包中确认部署交易...");
  const factory = new ethers.ContractFactory(state.compiled.abi, state.compiled.bytecode, state.signer);
  const contract = await factory.deploy(...args);
  log(`部署交易已提交：${contract.deploymentTransaction().hash}`);
  await contract.waitForDeployment();
  const address = await contract.getAddress();
  const constructorArgs = ethers.AbiCoder.defaultAbiCoder().encode(CONSTRUCTOR_TYPES, args).slice(2);
  const deploymentInfo = {
    contractAddress: address,
    contractName: "ModaFairMintTokenV1.sol:ModaFairMintTokenV1",
    compilerVersion: "v0.8.24+commit.e11b9ed9",
    openZeppelinVersion: "5.0.2",
    optimizer: { enabled: true, runs: 200 },
    constructorArguments: constructorArgs,
    constructorValues: args,
    deployer: state.account,
    chainId: (await state.provider.getNetwork()).chainId.toString(),
    transactionHash: contract.deploymentTransaction().hash,
    deployedAt: new Date().toISOString()
  };
  makeDownload("downloadStandardJson", "verify-standard-json-input.json", jsonSafe(state.compiled.standardJsonInput));
  makeDownload("downloadConstructorArgs", "constructor-args.txt", constructorArgs, "text/plain");
  makeDownload("downloadDeploymentInfo", "deployment-info.json", jsonSafe(deploymentInfo));
  $("verificationBox").hidden = false;
  $("adminContractAddress").value = address;
  $("mintContractAddress").value = address;
  state.admin = contract;
  state.mint = contract;
  log(`部署完成：${address}`);
  await refreshAdmin();
  await refreshMint();
}

async function ensureWallet() {
  if (!state.signer) await connectWallet();
}

async function contractAt(address) {
  await ensureWallet();
  if (!state.compiled) await compileContract();
  return new ethers.Contract(address, state.compiled.abi, state.signer);
}

async function refreshMint() {
  if (!state.mint) return;
  const [mintPrice, tokenPerMint, mintedCount, maxMintCount, mintEnabled, mode, pendingToken, pendingLP] = await Promise.all([
    state.mint.mintPrice(), state.mint.tokenPerMint(), state.mint.mintedCount(), state.mint.maxMintCount(),
    state.mint.mintEnabled(), state.mint.mintMode(), state.mint.pendingTokenDividend(state.account), state.mint.pendingLPDividend(state.account)
  ]);
  renderStats("mintStats", [
    ["Mint 价格", ethers.formatUnits(mintPrice, 18)],
    ["单次代币", ethers.formatUnits(tokenPerMint, 18)],
    ["进度", `${mintedCount} / ${maxMintCount}`],
    ["Mint 状态", mintEnabled ? "开启" : "关闭"],
    ["模式", Number(mode) === 0 ? "BNB" : "USDT"],
    ["可领取分红", ethers.formatUnits(pendingToken + pendingLP, 18)]
  ]);
}

async function refreshAdmin() {
  if (!state.admin) return;
  const [
    owner, pair, mintMode, mintPrice, tokenPerMint, mintedCount, maxMintCount, mintEnabled, tradingOpen,
    buyTax, sellTax, transferTax, marketingShare, burnShare, lpShare, marketingWallet, swapThreshold
  ] = await Promise.all([
    state.admin.owner(), state.admin.pair(), state.admin.mintMode(), state.admin.mintPrice(), state.admin.tokenPerMint(),
    state.admin.mintedCount(), state.admin.maxMintCount(), state.admin.mintEnabled(), state.admin.tradingOpen(),
    state.admin.buyTax(), state.admin.sellTax(), state.admin.transferTax(), state.admin.marketingShare(),
    state.admin.burnShare(), state.admin.lpShare(), state.admin.marketingWallet(), state.admin.swapThreshold()
  ]);
  renderStats("adminStats", [
    ["Owner", owner], ["Pair", pair], ["Mint 模式", Number(mintMode) === 0 ? "BNB" : "USDT"],
    ["Mint 价格", ethers.formatUnits(mintPrice, 18)], ["单次代币", ethers.formatUnits(tokenPerMint, 18)],
    ["Mint 进度", `${mintedCount} / ${maxMintCount}`], ["Mint", mintEnabled ? "开启" : "关闭"],
    ["交易", tradingOpen ? "已开启" : "未开启"], ["买/卖/转税", `${buyTax}/${sellTax}/${transferTax} BP`],
    ["分配", `${marketingShare}/${burnShare}/${lpShare} BP`], ["营销钱包", marketingWallet],
    ["Swap 阈值", ethers.formatUnits(swapThreshold, 18)]
  ]);
}

function renderStats(id, items) {
  $(id).innerHTML = items.map(([k, v]) => `<div class="stat"><span>${k}</span><strong>${v}</strong></div>`).join("");
}

async function mintNow() {
  await ensureWallet();
  if (!state.mint) state.mint = await contractAt($("mintContractAddress").value.trim());
  const contractAddress = await state.mint.getAddress();
  const mode = Number(await state.mint.mintMode());
  const price = await state.mint.mintPrice();
  if (mode === 0) await txDone(await state.mint.mintBNB({ value: price }), "Mint");
  else {
    await approveIfNeeded(await state.mint.usdtAddress(), contractAddress, price, "USDT Mint");
    await txDone(await state.mint.mintUSDT(), "Mint");
  }
  await refreshMint();
}

async function adminAction(action) {
  await ensureWallet();
  if (!state.admin) state.admin = await contractAt($("adminContractAddress").value.trim());
  const c = state.admin;
  const contractAddress = await c.getAddress();
  const listAddress = $("listAddress").value.trim();
  const listValue = parseBool($("listValue").value);
  const mode = Number(await c.mintMode());
  const usdt = mode === 1 ? await c.usdtAddress() : ZERO;
  const calls = {
    setMintPrice: () => c.setMintPrice(parseToken($("newMintPrice").value)),
    setTokenPerMint: () => c.setTokenPerMint(parseToken($("newTokenPerMint").value)),
    setMaxMintCount: () => c.setMaxMintCount(BigInt($("newMaxMintCount").value)),
    setLaunchTime: () => c.setLaunchTime(BigInt(Math.floor(new Date($("newLaunchTime").value).getTime() / 1000))),
    openTrading: () => c.openTrading(),
    closeMint: () => c.closeMint(),
    pause: () => c.pause(),
    unpause: () => c.unpause(),
    setWhitelistEnabled: () => c.setWhitelistEnabled(parseBool($("whitelistEnabled").value)),
    setWhitelist: () => c.setWhitelist(listAddress, listValue),
    setBlacklist: () => c.setBlacklist(listAddress, listValue),
    setExcludedFromLimits: () => c.setExcludedFromLimits(listAddress, listValue),
    setExcludedFromFee: () => c.setExcludedFromFee(listAddress, listValue),
    setBuyTax: () => c.setBuyTax(BigInt($("buyTax").value)),
    setSellTax: () => c.setSellTax(BigInt($("sellTax").value)),
    setTransferTax: () => c.setTransferTax(BigInt($("transferTax").value)),
    setTaxShares: () => c.setTaxShares(BigInt($("marketingShare").value), BigInt($("burnShare").value), BigInt($("lpShare").value)),
    setMarketingWallet: () => c.setMarketingWallet($("marketingWallet").value.trim()),
    setSwapThreshold: () => c.setSwapThreshold(parseToken($("swapThreshold").value)),
    forceSwapBack: () => c.forceSwapBack(),
    fundTokenDividend: async () => {
      const amount = parseToken($("dividendAmount").value);
      if (mode === 0) return c.fundTokenDividendBNB({ value: amount });
      await approveIfNeeded(usdt, contractAddress, amount, "USDT 分红");
      return c.fundTokenDividendUSDT(amount);
    },
    fundLPDividend: async () => {
      const amount = parseToken($("lpDividendAmount").value);
      if (mode === 0) return c.fundLPDividendBNB({ value: amount });
      await approveIfNeeded(usdt, contractAddress, amount, "USDT LP 分红");
      return c.fundLPDividendUSDT(amount);
    },
    forceAddLiquidity: async () => {
      const tokenAmount = parseToken($("liqTokenAmount").value);
      const fundAmount = parseToken($("liqFundAmount").value);
      if (mode === 0) return c.forceAddLiquidity(tokenAmount, fundAmount, { value: fundAmount });
      await approveIfNeeded(usdt, contractAddress, fundAmount, "USDT 加池");
      return c.forceAddLiquidity(tokenAmount, fundAmount);
    },
    withdrawBNB: () => c.withdrawBNB($("withdrawBNBAmount").value ? parseToken($("withdrawBNBAmount").value) : 0n),
    withdrawToken: () => c.withdrawToken($("withdrawTokenAddress").value.trim(), $("withdrawTokenAmount").value ? parseToken($("withdrawTokenAmount").value) : 0n),
    withdrawLP: () => c.withdrawLP($("withdrawLPAmount").value ? parseToken($("withdrawLPAmount").value) : 0n)
  };
  if (!calls[action]) throw new Error(`未知操作：${action}`);
  await txDone(await calls[action](), action);
  await refreshAdmin();
}

document.querySelectorAll(".tab").forEach((btn) => btn.addEventListener("click", () => {
  document.querySelectorAll(".tab,.panel").forEach((el) => el.classList.remove("active"));
  btn.classList.add("active");
  $(btn.dataset.tab).classList.add("active");
}));

$("connectWallet").addEventListener("click", async (e) => run(e.currentTarget, connectWallet));
$("compileContract").addEventListener("click", async (e) => run(e.currentTarget, compileContract));
$("deployForm").addEventListener("submit", async (e) => run(e.submitter, () => deployContract(e)));
$("loadMintInfo").addEventListener("click", async (e) => run(e.currentTarget, async () => { state.mint = await contractAt($("mintContractAddress").value.trim()); await refreshMint(); }));
$("mintNow").addEventListener("click", async (e) => run(e.currentTarget, mintNow));
$("claimDividends").addEventListener("click", async (e) => run(e.currentTarget, async () => { if (!state.mint) state.mint = await contractAt($("mintContractAddress").value.trim()); await txDone(await state.mint.claimDividends(), "领取分红"); await refreshMint(); }));
$("loadAdmin").addEventListener("click", async (e) => run(e.currentTarget, async () => { state.admin = await contractAt($("adminContractAddress").value.trim()); await refreshAdmin(); }));
$("refreshAdmin").addEventListener("click", async (e) => run(e.currentTarget, refreshAdmin));
document.querySelectorAll("[data-action]").forEach((btn) => btn.addEventListener("click", async () => run(btn, () => adminAction(btn.dataset.action))));

async function run(button, fn) {
  try {
    setBusy(button, true);
    await fn();
  } catch (err) {
    console.error(err);
    log(err.shortMessage || err.message || String(err));
  } finally {
    setBusy(button, false);
  }
}
