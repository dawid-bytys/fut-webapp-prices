// ==UserScript==
// @name         FC Web App Prices
// @namespace    http://tampermonkey.net/
// @version      1.0
// @description  Display fut.gg prices
// @author       You
// @match        https://www.ea.com/ea-sports-fc/ultimate-team/web-app/*
// @grant        GM_xmlhttpRequest
// @connect      fut.gg
// @run-at       document-idle
// ==/UserScript==

const CONFIG = {
  CACHE_DURATION: 2 * 60 * 1000,
  MIN_PROFIT: 10000,
  EA_TAX: 0.05,
  QUEUE_INTERVAL: 300,
  PLATFORM: 'pc',
  API_VERSION: '26',
  OUTLIER_MEDIAN_DEVIATION: 0.3,
  OUTLIER_IQR_MULTIPLIER: 1.5,
  TOP_SALES_COUNT: 10,
  COIN_ICON_URL: 'https://www.ea.com/es-es/ea-sports-fc/ultimate-team/web-app/images/coinIcon.png',
};

const RARITIES_TO_REMOVE = new Set([
  'Common',
  'Rare',
  'Classic XI Hero',
  'Evolutions I',
  'Flashback',
  'In-Progress Evolution',
  'Moments',
  'POTM Bundesliga',
  'POTM LALIGA EA SPORTS',
  'POTM LIGA F',
  'POTM Premier League',
  'POTM Serie A',
  'POTM Ligue 1',
  'Premium World Tour',
  'Season Ladder Excellence',
  'Showdown',
  'Showdown Upgrade',
  'Squad Foundations',
  'Team of the Year Honourable Mentions Hero',
  'TOTY HM Evolution',
  'UT Origin Heroes',
  'Unbreakables Evolution',
  'Winter Wildcards Hero Red',
  'Winter Wildcards ICON Red',
  'Winter Wildcards Red',
  'World Tour',
  'World Tour Silver Superstar',
  'Future Stars Academy',
]);

const SELECTORS = {
  LIST_CONTAINER: 'div.paginated-item-list.ut-pinned-list > ul',
  FILTER_CONTAINER:
    'div.ut-pinned-list-container.ut-content-container > div > div.ut-pinned-list > div:nth-child(4) > div:nth-child(5)',
  INLINE_LIST: '.inline-list',
  DEFINITION_ID: '[data-definition-id]',
  PRICES_CONTAINER: '.prices-container',
  PRICE_ELEMENT: '.auction > div:nth-child(3) > span.currency-coins.value',
  PAGING: '.pagingContainer, .ut-paging-control',
  LIST_ITEM: 'li.listFUTItem',
};

class CacheManager {
  constructor() {
    this.basicCache = new Map();
    this.detailedCache = new Map();
    this.loadFromStorage();
    this.startCleanupTimer();
  }

  loadFromStorage() {
    try {
      const stored = localStorage.getItem('futgg_detailed_cache');
      if (!stored) {
        return;
      }

      const parsed = JSON.parse(stored);

      for (const [id, data] of Object.entries(parsed)) {
        this.detailedCache.set(id, data);
      }
    } catch (error) {
      console.error('Failed to load cache:', error);
    }
  }

  saveToStorage() {
    try {
      const data = Object.fromEntries(this.detailedCache);
      localStorage.setItem('futgg_detailed_cache', JSON.stringify(data));
    } catch (error) {
      console.error('Failed to save cache:', error);
    }
  }

  startCleanupTimer() {
    setInterval(() => {
      const now = Date.now();

      for (const [id, cached] of this.basicCache.entries()) {
        if (now - cached.timestamp >= CONFIG.CACHE_DURATION) {
          this.basicCache.delete(id);
        }
      }
    }, 60 * 1000);
  }

  getBasicPrice(definitionId) {
    const cached = this.basicCache.get(definitionId);
    if (!cached) {
      return null;
    }

    const now = Date.now();
    if (now - cached.timestamp >= CONFIG.CACHE_DURATION) {
      this.basicCache.delete(definitionId);
      return null;
    }

    return cached.data;
  }

  setBasicPrice(definitionId, data) {
    this.basicCache.set(definitionId, {
      data,
      timestamp: Date.now(),
    });
  }

  getDetailedPrice(definitionId) {
    return this.detailedCache.get(definitionId);
  }

  setDetailedPrice(definitionId, avgSalePrice) {
    this.detailedCache.set(definitionId, {
      avgSalePrice,
      timestamp: Date.now(),
    });
    this.saveToStorage();
  }

  hasDetailedPrice(definitionId) {
    return this.detailedCache.has(definitionId);
  }

  getAllDetailedIds() {
    return [...this.detailedCache.keys()];
  }
}

class ApiClient {
  async fetchBasicPrices(definitionIds) {
    const idsString = definitionIds.join(',');
    const url = `https://www.fut.gg/api/fut/player-prices/${CONFIG.API_VERSION}/?ids=${idsString}&platform=${CONFIG.PLATFORM}`;

    return new Promise(resolve => {
      GM_xmlhttpRequest({
        method: 'GET',
        url,
        onload: response => {
          try {
            const json = JSON.parse(response.responseText);
            resolve(json?.data || []);
          } catch (error) {
            console.error('Failed to parse basic prices:', error);
            resolve([]);
          }
        },
        onerror: () => resolve([]),
      });
    });
  }

  async fetchPlayerDetails(definitionId) {
    const url = `https://www.fut.gg/api/fut/player-prices/${CONFIG.API_VERSION}/${definitionId}/?platform=${CONFIG.PLATFORM}`;

    return new Promise((resolve, reject) => {
      GM_xmlhttpRequest({
        method: 'GET',
        url,
        onload: response => {
          try {
            const json = JSON.parse(response.responseText);
            resolve(json.data);
          } catch (error) {
            reject(error);
          }
        },
        onerror: reject,
      });
    });
  }
}

class PriceCalculator {
  static removeOutliers(prices) {
    const sorted = [...prices].sort((a, b) => a - b);
    const median = sorted[Math.floor(sorted.length / 2)];

    const q1 = sorted[Math.floor(sorted.length * 0.25)];
    const q3 = sorted[Math.floor(sorted.length * 0.75)];
    const iqr = q3 - q1;
    const lowerBound = q1 - CONFIG.OUTLIER_IQR_MULTIPLIER * iqr;
    const upperBound = q3 + CONFIG.OUTLIER_IQR_MULTIPLIER * iqr;

    let filtered = prices.filter(p => p >= lowerBound && p <= upperBound);

    filtered = filtered.filter(price => {
      const deviation = Math.abs(price - median) / median;
      return deviation <= CONFIG.OUTLIER_MEDIAN_DEVIATION;
    });

    return filtered.length > 0 ? filtered : prices;
  }

  static calculateProfit(buyPrice, sellPrice) {
    const actualReceived = sellPrice * (1 - CONFIG.EA_TAX);
    return actualReceived - buyPrice;
  }

  static isGoodDeal(currentPrice, avgSalePrice) {
    if (!currentPrice || !avgSalePrice) {
      return false;
    }

    const profit = this.calculateProfit(currentPrice, avgSalePrice);
    return profit >= CONFIG.MIN_PROFIT;
  }

  static calculateAvgSalePrice(playerDetails) {
    if (!playerDetails?.completedAuctions?.length) {
      return null;
    }

    const topSales = playerDetails.completedAuctions.slice(0, CONFIG.TOP_SALES_COUNT);
    const prices = topSales.map(auction => auction.soldPrice);
    const filteredPrices = this.removeOutliers(prices);

    if (!filteredPrices.length) {
      return null;
    }

    const sum = filteredPrices.reduce((acc, price) => acc + price, 0);
    return Math.round(sum / filteredPrices.length);
  }
}

class Formatter {
  static formatPrice(price) {
    return `<span class="futgg-price-coin"><img src="${CONFIG.COIN_ICON_URL}">${price.toLocaleString()}</span>`;
  }

  static formatDate(dateStr) {
    const date = new Date(dateStr);
    const now = new Date();
    const diffMs = now - date;
    const diffMins = Math.floor(diffMs / 60000);

    if (diffMins < 60) {
      return `${diffMins}m ago`;
    }

    if (diffMins < 1440) {
      return `${Math.floor(diffMins / 60)}h ago`;
    }

    return date.toLocaleString();
  }
}

class OverlayRegistry {
  constructor() {
    this.registry = new Map();
  }

  register(definitionId, overlayElement) {
    if (!this.registry.has(definitionId)) {
      this.registry.set(definitionId, new Set());
    }
    this.registry.get(definitionId).add(overlayElement);
  }

  unregister(overlayElement) {
    const definitionId = overlayElement?.dataset?.futggDefinitionId;
    if (!definitionId) {
      return;
    }

    const set = this.registry.get(definitionId);
    if (!set) {
      return;
    }

    set.delete(overlayElement);

    if (set.size === 0) {
      this.registry.delete(definitionId);
    }
  }

  pruneDisconnected(definitionId) {
    const set = this.registry.get(definitionId);

    if (!set) {
      return;
    }

    for (const overlayElement of [...set]) {
      if (!overlayElement.isConnected) {
        set.delete(overlayElement);
      }
    }

    if (set.size === 0) {
      this.registry.delete(definitionId);
    }
  }

  getOverlays(definitionId) {
    return this.registry.get(definitionId);
  }
}

class FetchQueue {
  constructor() {
    this.queue = [];
    this.pending = new Set();
    this.timerId = null;
    this.isBusy = false;
  }

  enqueue(definitionId) {
    if (!definitionId || this.pending.has(definitionId)) {
      return;
    }

    this.pending.add(definitionId);
    this.queue.push(definitionId);
  }

  dequeue() {
    const id = this.queue.shift();

    if (id) {
      this.pending.delete(id);
    }

    return id;
  }

  remove(definitionId) {
    this.pending.delete(definitionId);
    const index = this.queue.indexOf(definitionId);

    if (index >= 0) {
      this.queue.splice(index, 1);
    }
  }

  get length() {
    return this.queue.length;
  }

  get busy() {
    return this.isBusy;
  }

  set busy(value) {
    this.isBusy = value;
  }
}

class ModalBuilder {
  static show(data, avgSalePrice, avgTimestamp, currentPrice) {
    this.closeExisting();

    const overlay = document.createElement('div');
    overlay.className = 'futgg-modal-overlay';
    overlay.innerHTML = this.buildContent(data, avgSalePrice, avgTimestamp, currentPrice);

    document.body.appendChild(overlay);
    this.attachEventListeners(overlay);
  }

  static closeExisting() {
    const existing = document.querySelector('.futgg-modal-overlay');
    if (existing) {
      existing.remove();
    }
  }

  static buildContent(data, avgSalePrice, avgTimestamp, currentPrice) {
    const updatedAtText = avgTimestamp ? new Date(avgTimestamp).toLocaleString() : 'N/A';
    const profitSection = this.buildProfitSection(currentPrice, avgSalePrice);

    return `
              <div class="futgg-modal">
                  <div class="futgg-modal-header">
                      <h2>Player Price Details</h2>
                      <button class="futgg-modal-close">×</button>
                  </div>
  
                  <div class="futgg-modal-section">
                      <h3>Current Price Info</h3>
                      ${
                        currentPrice
                          ? `
                      <div class="futgg-stat-row">
                          <span class="futgg-stat-label">Listing Price:</span>
                          <span class="futgg-stat-value">${Formatter.formatPrice(currentPrice)}</span>
                      </div>
                      `
                          : ''
                      }
                      <div class="futgg-stat-row">
                          <span class="futgg-stat-label">Current Price:</span>
                          <span class="futgg-stat-value">${Formatter.formatPrice(data.currentPrice.price)}</span>
                      </div>
                      ${
                        avgSalePrice
                          ? `
                      <div class="futgg-stat-row">
                          <span class="futgg-stat-label">Avg Recent Sale (Top 10):</span>
                          <span class="futgg-stat-value">${Formatter.formatPrice(avgSalePrice)}</span>
                      </div>
                      ${profitSection}
                      <div class="futgg-stat-row">
                          <span class="futgg-stat-label">Avg. updated at:</span>
                          <span class="futgg-stat-value">${updatedAtText}</span>
                      </div>
                      `
                          : ''
                      }
                      <div class="futgg-stat-row">
                          <span class="futgg-stat-label">Average BIN:</span>
                          <span class="futgg-stat-value">${Formatter.formatPrice(data.overview.averageBin)}</span>
                      </div>
                      <div class="futgg-stat-row">
                          <span class="futgg-stat-label">Cheapest Sale:</span>
                          <span class="futgg-stat-value">${Formatter.formatPrice(data.overview.cheapestSale)}</span>
                      </div>
                      <div class="futgg-stat-row">
                          <span class="futgg-stat-label">Discard Value:</span>
                          <span class="futgg-stat-value">${Formatter.formatPrice(data.overview.discardValue)}</span>
                      </div>
                      <div class="futgg-stat-row">
                          <span class="futgg-stat-label">Price Range:</span>
                          <span class="futgg-stat-value">${Formatter.formatPrice(data.priceRange.minPrice)} - ${Formatter.formatPrice(data.priceRange.maxPrice)}</span>
                      </div>
                  </div>
  
                  ${this.buildCompletedAuctionsSection(data.completedAuctions)}
                  ${this.buildLiveAuctionsSection(data.liveAuctions)}
              </div>
          `;
  }

  static buildProfitSection(currentPrice, avgSalePrice) {
    if (!currentPrice || !avgSalePrice) {
      return '';
    }

    const profit = PriceCalculator.calculateProfit(currentPrice, avgSalePrice);
    const afterTax = Math.round(avgSalePrice * (1 - CONFIG.EA_TAX));
    const profitClass = profit >= 0 ? 'futgg-profit' : 'futgg-loss';

    return `
              <div class="futgg-stat-row">
                  <span class="futgg-stat-label">After Tax (95%):</span>
                  <span class="futgg-stat-value">${Formatter.formatPrice(afterTax)}</span>
              </div>
              <div class="futgg-stat-row">
                  <span class="futgg-stat-label">Net Profit:</span>
                  <span class="futgg-stat-value ${profitClass}">${Formatter.formatPrice(Math.round(profit))}</span>
              </div>
          `;
  }

  static buildCompletedAuctionsSection(auctions) {
    if (!auctions?.length) {
      return '';
    }

    return `
              <div class="futgg-modal-section">
                  <h3>Recent Completed Auctions (${auctions.length})</h3>
                  <table class="futgg-auction-table">
                      <thead>
                          <tr>
                              <th>Sold Price</th>
                              <th>Time</th>
                          </tr>
                      </thead>
                      <tbody>
                          ${auctions
                            .map(
                              auction => `
                              <tr>
                                  <td>${Formatter.formatPrice(auction.soldPrice)}</td>
                                  <td>${Formatter.formatDate(auction.soldDate)}</td>
                              </tr>
                          `,
                            )
                            .join('')}
                      </tbody>
                  </table>
              </div>
          `;
  }

  static buildLiveAuctionsSection(auctions) {
    if (!auctions?.length) {
      return '';
    }

    return `
              <div class="futgg-modal-section">
                  <h3>Live Auctions (${auctions.length})</h3>
                  <table class="futgg-auction-table">
                      <thead>
                          <tr>
                              <th>Buy Now</th>
                              <th>Starting Bid</th>
                              <th>Ends</th>
                          </tr>
                      </thead>
                      <tbody>
                          ${auctions
                            .map(
                              auction => `
                              <tr>
                                  <td>${Formatter.formatPrice(auction.buyNowPrice)}</td>
                                  <td>${Formatter.formatPrice(auction.startingBid)}</td>
                                  <td>${Formatter.formatDate(auction.endDate)}</td>
                              </tr>
                          `,
                            )
                            .join('')}
                      </tbody>
                  </table>
              </div>
          `;
  }

  static attachEventListeners(overlay) {
    const closeBtn = overlay.querySelector('.futgg-modal-close');
    closeBtn.addEventListener('click', () => overlay.remove());

    overlay.addEventListener('click', e => {
      if (e.target === overlay) {
        overlay.remove();
      }
    });
  }
}

class StyleInjector {
  static inject() {
    const style = document.createElement('style');
    style.textContent = `
              .futgg-price-overlay {
                  padding: 0.3rem 0.4rem;
                  white-space: nowrap;
                  background: #1e242a;
                  border: 1px solid #ff3c00;
                  border-radius: 5px;
                  color: #fff;
                  font-size: 14px;
                  font-weight: bold;
                  display: flex;
                  align-items: center;
                  gap: 5px;
                  margin-top: 0.2rem;
                  cursor: pointer;
              }
              .futgg-price-overlay img {
                  width: 18px;
                  height: 18px;
                  flex-shrink: 0;
              }
              .futgg-avg-price {
                  font-size: 12px;
                  color: #aaa;
                  margin-left: 5px;
              }
              .futgg-good-deal {
                  animation: pulse-green 2s infinite;
                  box-shadow: 0 0 15px rgba(0, 255, 0, 0.6);
              }
              @keyframes pulse-green {
                  0%, 100% { background-color: rgba(0, 255, 0, 0.1); border: 2px solid rgba(0, 255, 0, 0.3); }
                  50% { background-color: rgba(0, 255, 0, 0.3); border: 2px solid rgba(0, 255, 0, 0.6); }
              }
              .pagingContainer, .ut-paging-control {
                  display: block;
              }
              .futgg-modal-overlay {
                  position: fixed;
                  top: 0;
                  left: 0;
                  width: 100%;
                  height: 100%;
                  background: rgba(0, 0, 0, 0.8);
                  display: flex;
                  align-items: center;
                  justify-content: center;
                  z-index: 10000;
              }
              .futgg-modal {
                  background: #1e242a;
                  border: 2px solid #ff3c00;
                  border-radius: 10px;
                  width: 90%;
                  max-width: 800px;
                  max-height: 90vh;
                  overflow-y: auto;
                  padding: 20px;
                  color: #fff;
              }
              .futgg-modal-header {
                  display: flex;
                  justify-content: space-between;
                  align-items: center;
                  margin-bottom: 20px;
                  border-bottom: 2px solid #ff3c00;
                  padding-bottom: 10px;
              }
              .futgg-modal-header h2 {
                  margin: 0;
                  color: #ff3c00;
              }
              .futgg-modal-close {
                  background: #ff3c00;
                  border: none;
                  color: white;
                  font-size: 24px;
                  cursor: pointer;
                  width: 30px;
                  height: 30px;
                  border-radius: 50%;
                  display: flex;
                  align-items: center;
                  justify-content: center;
              }
              .futgg-modal-close:hover {
                  background: #ff5722;
              }
              .futgg-modal-section {
                  margin-bottom: 20px;
              }
              .futgg-modal-section h3 {
                  color: #ff3c00;
                  margin-top: 0;
                  margin-bottom: 10px;
                  font-size: 18px;
              }
              .futgg-stat-row {
                  display: flex;
                  justify-content: space-between;
                  padding: 8px 0;
                  border-bottom: 1px solid #333;
              }
              .futgg-stat-label {
                  color: #aaa;
              }
              .futgg-stat-value {
                  color: #fff;
                  font-weight: bold;
              }
              .futgg-profit {
                  color: #00ff00;
                  font-weight: bold;
              }
              .futgg-loss {
                  color: #ff0000;
                  font-weight: bold;
              }
              .futgg-auction-table {
                  width: 100%;
                  border-collapse: collapse;
                  margin-top: 10px;
              }
              .futgg-auction-table th {
                  background: #2a3139;
                  padding: 10px;
                  text-align: left;
                  border-bottom: 2px solid #ff3c00;
              }
              .futgg-auction-table td {
                  padding: 8px 10px;
                  border-bottom: 1px solid #333;
              }
              .futgg-auction-table tr:hover {
                  background: #2a3139;
              }
              .futgg-price-coin {
                  display: inline-flex;
                  align-items: center;
                  gap: 5px;
              }
              .futgg-price-coin img {
                  width: 16px;
                  height: 16px;
              }
              .futgg-loading {
                  text-align: center;
                  padding: 40px;
                  font-size: 18px;
              }
          `;
    document.head.appendChild(style);
  }
}

class DomHelper {
  static unhidePaging() {
    const pagers = document.querySelectorAll(SELECTORS.PAGING);

    for (const el of pagers) {
      if (el.style.display === 'none') {
        el.style.removeProperty('display');
      }

      const children = Array.from(el.children);

      for (const child of children) {
        if (window.getComputedStyle(child).display === 'none') {
          child.style.removeProperty('display');
        }
      }
    }
  }

  static getDefinitionId(element) {
    const itemWithId =
      element.querySelector(SELECTORS.DEFINITION_ID) ||
      (element.hasAttribute('data-definition-id') ? element : null);

    return itemWithId?.getAttribute('data-definition-id');
  }

  static getCurrentPrice(listItem) {
    const priceElement = listItem.querySelector(SELECTORS.PRICE_ELEMENT);
    if (!priceElement) {
      return null;
    }

    const price = parseInt(priceElement.textContent.replace(/,/g, ''), 10);
    return Number.isNaN(price) ? null : price;
  }
}

class FilterManager {
  constructor() {
    this.observer = null;
  }

  start() {
    const filterContainer = document.querySelector(SELECTORS.FILTER_CONTAINER);
    if (!filterContainer) {
      return;
    }

    this.observer = new MutationObserver(mutations => {
      for (const mutation of mutations) {
        if (mutation.type === 'attributes' && mutation.attributeName === 'class') {
          this.cleanDropdown();
        }
      }
    });

    this.observer.observe(filterContainer, {
      attributes: true,
      attributeFilter: ['class'],
    });

    this.cleanDropdown();
  }

  cleanDropdown() {
    const filterContainer = document.querySelector(SELECTORS.FILTER_CONTAINER);
    if (!filterContainer || !filterContainer.classList.contains('is-open')) {
      return;
    }

    const inlineList = filterContainer.querySelector(SELECTORS.INLINE_LIST);
    if (!inlineList) {
      return;
    }

    const listItems = Array.from(inlineList.children);

    for (const li of listItems) {
      const text = li.textContent.trim();

      if (RARITIES_TO_REMOVE.has(text)) {
        li.style.display = 'none';
      }
    }
  }
}

class PriceOverlayManager {
  constructor(cacheManager, overlayRegistry, apiClient, fetchQueue) {
    this.cache = cacheManager;
    this.registry = overlayRegistry;
    this.api = apiClient;
    this.queue = fetchQueue;
  }

  async fetchAndCachePrices(definitionIds) {
    if (!definitionIds?.length) {
      return {};
    }

    const uniqueIds = [...new Set(definitionIds)];
    const resultMap = {};
    const idsToFetch = [];

    for (const id of uniqueIds) {
      const cached = this.cache.getBasicPrice(id);

      if (cached) {
        resultMap[id] = cached;
      } else {
        idsToFetch.push(id);
      }
    }

    if (!idsToFetch.length) {
      return resultMap;
    }

    const items = await this.api.fetchBasicPrices(idsToFetch);

    for (const item of items) {
      this.cache.setBasicPrice(item.eaId, item);
      resultMap[item.eaId] = item;
    }

    return resultMap;
  }

  buildOverlayHtml(itemPriceData, detailedCache) {
    const avgPart = detailedCache?.avgSalePrice
      ? `<span class="futgg-avg-price">(Avg: ${detailedCache.avgSalePrice.toLocaleString()})</span>`
      : '';

    return `
              <img src="${CONFIG.COIN_ICON_URL}">
              <span class="futgg-current-price">${itemPriceData.price.toLocaleString()}</span>
              ${avgPart}
          `;
  }

  createOverlay(definitionId, itemPriceData, detailedCache) {
    const overlay = document.createElement('div');
    overlay.className = 'futgg-price-overlay';
    overlay.dataset.futggDefinitionId = definitionId;
    overlay.innerHTML = this.buildOverlayHtml(itemPriceData, detailedCache);

    return overlay;
  }

  attachOverlayClickHandler(overlay, definitionId, currentPrice) {
    overlay.addEventListener('click', async event => {
      event.stopPropagation();
      event.preventDefault();

      this.queue.remove(definitionId);

      const loadingOverlay = document.createElement('div');
      loadingOverlay.className = 'futgg-modal-overlay';
      loadingOverlay.innerHTML = `
                  <div class="futgg-modal">
                      <div class="futgg-loading">Loading player details...</div>
                  </div>
              `;
      document.body.appendChild(loadingOverlay);

      try {
        const playerDetails = await this.api.fetchPlayerDetails(definitionId);
        const avgSalePrice = PriceCalculator.calculateAvgSalePrice(playerDetails);

        this.cache.setDetailedPrice(definitionId, avgSalePrice);
        this.updateOverlays(definitionId);

        loadingOverlay.remove();
        ModalBuilder.show(playerDetails, avgSalePrice, Date.now(), currentPrice);
      } catch (error) {
        loadingOverlay.remove();
        alert('Failed to load player details. Please try again.');
      }
    });
  }

  processItem(listItem, priceData) {
    const definitionId = DomHelper.getDefinitionId(listItem);
    if (!definitionId) {
      return;
    }

    const pricesContainer = listItem.querySelector(SELECTORS.PRICES_CONTAINER);
    if (!pricesContainer) {
      return;
    }

    const existingOverlay = pricesContainer.querySelector('.futgg-price-overlay');
    if (existingOverlay) {
      this.registry.unregister(existingOverlay);
      existingOverlay.remove();
    }

    listItem.classList.remove('futgg-good-deal');

    const itemPriceData = priceData[definitionId];
    if (!itemPriceData?.price) {
      return;
    }

    const detailedCache = this.cache.getDetailedPrice(definitionId);
    const overlay = this.createOverlay(definitionId, itemPriceData, detailedCache);

    this.registry.register(definitionId, overlay);

    const currentPrice = DomHelper.getCurrentPrice(listItem);
    this.attachOverlayClickHandler(overlay, definitionId, currentPrice);

    pricesContainer.appendChild(overlay);
    this.updateGoodDealState(listItem);
  }

  updateGoodDealState(listItem) {
    if (!listItem) {
      return;
    }

    listItem.classList.remove('futgg-good-deal');

    const definitionId = DomHelper.getDefinitionId(listItem);
    if (!definitionId) {
      return;
    }

    const detailedCache = this.cache.getDetailedPrice(definitionId);
    const basicCache = this.cache.getBasicPrice(definitionId);

    const currentPrice = DomHelper.getCurrentPrice(listItem);
    if (!currentPrice) {
      return;
    }

    const comparePrice = detailedCache?.avgSalePrice || basicCache?.price;
    if (!comparePrice) {
      return;
    }

    if (PriceCalculator.isGoodDeal(currentPrice, comparePrice)) {
      listItem.classList.add('futgg-good-deal');
    }
  }

  updateOverlays(definitionId) {
    this.registry.pruneDisconnected(definitionId);

    const overlays = this.registry.getOverlays(definitionId);

    if (!overlays) {
      return;
    }

    const detailedCache = this.cache.getDetailedPrice(definitionId);
    const basicCache = this.cache.getBasicPrice(definitionId);

    for (const overlayElement of overlays) {
      const priceSpan = overlayElement.querySelector('.futgg-current-price');

      if (priceSpan && basicCache?.price) {
        priceSpan.textContent = basicCache.price.toLocaleString();
      }

      const avgSpan = overlayElement.querySelector('.futgg-avg-price');

      if (detailedCache?.avgSalePrice) {
        const avgText = `(Avg: ${detailedCache.avgSalePrice.toLocaleString()})`;

        if (avgSpan) {
          avgSpan.textContent = avgText;
        } else {
          const newAvgSpan = document.createElement('span');
          newAvgSpan.className = 'futgg-avg-price';
          newAvgSpan.textContent = avgText;
          overlayElement.appendChild(newAvgSpan);
        }
      } else {
        if (avgSpan) {
          avgSpan.remove();
        }
      }

      const listItem = overlayElement.closest(SELECTORS.LIST_ITEM);

      if (listItem) {
        this.updateGoodDealState(listItem);
      }
    }
  }
}

class DetailedPriceUpdater {
  constructor(cacheManager, overlayManager, apiClient) {
    this.cache = cacheManager;
    this.overlayManager = overlayManager;
    this.api = apiClient;
  }

  async update(definitionId) {
    const playerDetails = await this.api.fetchPlayerDetails(definitionId);
    const avgSalePrice = PriceCalculator.calculateAvgSalePrice(playerDetails);

    this.cache.setDetailedPrice(definitionId, avgSalePrice);
    this.overlayManager.updateOverlays(definitionId);
  }
}

class QueueProcessor {
  constructor(fetchQueue, detailedPriceUpdater) {
    this.queue = fetchQueue;
    this.updater = detailedPriceUpdater;
  }

  start() {
    if (this.queue.timerId) {
      return;
    }

    this.queue.timerId = setInterval(async () => {
      if (this.queue.busy) {
        return;
      }

      const definitionId = this.queue.dequeue();
      if (!definitionId) {
        return;
      }

      this.queue.busy = true;

      try {
        await this.updater.update(definitionId);
      } catch (error) {
        console.error('Failed to update player details:', error);
      } finally {
        this.queue.busy = false;
      }
    }, CONFIG.QUEUE_INTERVAL);
  }
}

class BackgroundRefresher {
  constructor(cacheManager, fetchQueue, detailedPriceUpdater) {
    this.cache = cacheManager;
    this.queue = fetchQueue;
    this.updater = detailedPriceUpdater;
    this.currentIndex = 0;
  }

  start() {
    setInterval(async () => {
      if (this.queue.length > 0 || this.queue.busy) {
        return;
      }

      const allCachedIds = this.cache.getAllDetailedIds();
      if (allCachedIds.length === 0) {
        this.currentIndex = 0;
        return;
      }

      if (this.currentIndex >= allCachedIds.length) {
        this.currentIndex = 0;
      }

      const definitionId = allCachedIds[this.currentIndex];
      this.currentIndex++;

      this.queue.busy = true;

      try {
        await this.updater.update(definitionId);
      } catch (error) {
        console.error('Background refresh failed:', error);
      } finally {
        this.queue.busy = false;
      }
    }, CONFIG.QUEUE_INTERVAL);
  }
}

class ListProcessor {
  constructor(overlayManager, fetchQueue, queueProcessor, cacheManager) {
    this.overlayManager = overlayManager;
    this.queue = fetchQueue;
    this.queueProcessor = queueProcessor;
    this.cache = cacheManager;
    this.isProcessing = false;
  }

  async process(list) {
    if (this.isProcessing) {
      return;
    }

    const validItems = await this.getValidItems(list);
    if (!validItems.length) {
      return;
    }

    this.isProcessing = true;

    try {
      const definitionIds = validItems.map(li => DomHelper.getDefinitionId(li)).filter(Boolean);
      const priceData = await this.overlayManager.fetchAndCachePrices(definitionIds);

      for (const li of validItems) {
        this.overlayManager.processItem(li, priceData);
      }

      DomHelper.unhidePaging();
      this.enqueueNewFetches(definitionIds);
      this.queueProcessor.start();
    } finally {
      this.isProcessing = false;
    }
  }

  async getValidItems(list) {
    const filterValid = () =>
      Array.from(list.children).filter(li => DomHelper.getDefinitionId(li) !== null);

    let validItems = filterValid();

    if (validItems.length === 0) {
      await new Promise(resolve => setTimeout(resolve, 500));
      validItems = filterValid();
    }

    return validItems;
  }

  enqueueNewFetches(definitionIds) {
    const uniqueIds = [...new Set(definitionIds)];

    for (const definitionId of uniqueIds) {
      if (this.cache.hasDetailedPrice(definitionId)) {
        this.overlayManager.updateOverlays(definitionId);
      } else {
        this.queue.enqueue(definitionId);
      }
    }
  }
}

class ListObserver {
  constructor(listProcessor) {
    this.processor = listProcessor;
    this.observer = null;
    this.hasInitialized = false;
  }

  start() {
    const targetNode = document.querySelector(SELECTORS.LIST_CONTAINER);
    DomHelper.unhidePaging();

    if (!targetNode) {
      this.hasInitialized = false;
      return;
    }

    if (this.hasInitialized) {
      return;
    }

    this.hasInitialized = true;
    this.processor.process(targetNode);

    if (this.observer) {
      this.observer.disconnect();
    }

    this.observer = new MutationObserver(mutations => {
      const hasNewItems = mutations.some(m => m.addedNodes.length > 0 || m.removedNodes.length > 0);

      if (hasNewItems) {
        this.processor.process(targetNode);
      }
    });

    this.observer.observe(targetNode, { childList: true });
  }
}

class PageObserver {
  constructor(listObserver, filterManager) {
    this.listObserver = listObserver;
    this.filterManager = filterManager;
    this.observer = null;
  }

  start() {
    this.observer = new MutationObserver(() => {
      DomHelper.unhidePaging();
      this.listObserver.start();
      this.filterManager.start();
    });

    this.observer.observe(document.body, {
      childList: true,
      subtree: true,
    });
  }
}

class Application {
  constructor() {
    this.cache = new CacheManager();
    this.overlayRegistry = new OverlayRegistry();
    this.apiClient = new ApiClient();
    this.fetchQueue = new FetchQueue();
    this.filterManager = new FilterManager();

    this.overlayManager = new PriceOverlayManager(
      this.cache,
      this.overlayRegistry,
      this.apiClient,
      this.fetchQueue,
    );

    this.detailedPriceUpdater = new DetailedPriceUpdater(
      this.cache,
      this.overlayManager,
      this.apiClient,
    );

    this.queueProcessor = new QueueProcessor(this.fetchQueue, this.detailedPriceUpdater);

    this.backgroundRefresher = new BackgroundRefresher(
      this.cache,
      this.fetchQueue,
      this.detailedPriceUpdater,
    );

    this.listProcessor = new ListProcessor(
      this.overlayManager,
      this.fetchQueue,
      this.queueProcessor,
      this.cache,
    );

    this.listObserver = new ListObserver(this.listProcessor);
    this.pageObserver = new PageObserver(this.listObserver, this.filterManager);
  }

  initialize() {
    StyleInjector.inject();
    this.listObserver.start();
    this.queueProcessor.start();
    this.backgroundRefresher.start();
    this.filterManager.start();
    this.pageObserver.start();
  }
}

function main() {
  const app = new Application();
  app.initialize();
}

main();
