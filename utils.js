let WHITELISTED_DOMAINS = ['thepiratebay.org', '1337x.to', 'rarbg.to', 'nyaa.si', 'eztv.re'];
let DOMAINS_LOADED = false;

function normalizeDomain(input) {
  if (!input || typeof input !== 'string') return null;
  let domain = input.trim().toLowerCase();
  domain = domain.replace(/^(https?:\/\/)?(www\.)?/, '');
  domain = domain.split('/')[0].split(':')[0].split('?')[0].split('#')[0];
  if (!domain || !/^[a-zA-Z0-9.-]+$/.test(domain) || domain.length > 253) return null;
  if (!domain.includes('.') && !['localhost', 'local'].includes(domain)) return null;
  return domain;
}

function getBaseDomain(hostname) {
  const parts = hostname.split('.');
  return parts.length <= 2 ? hostname : parts.slice(-2).join('.');
}

function isWhitelistedDomain(hostname = null) {
  const targetHostname = hostname || (typeof window !== 'undefined' ? window.location.hostname : '');
  if (!targetHostname) return false;
  
  const normalized = normalizeDomain(targetHostname);
  if (!normalized) return false;
  
  const baseDomain = getBaseDomain(normalized);
  return WHITELISTED_DOMAINS.some(domain => {
    const normalizedWhitelist = normalizeDomain(domain);
    if (!normalizedWhitelist) return false;
    const whitelistBase = getBaseDomain(normalizedWhitelist);
    return baseDomain === whitelistBase || 
           normalized === normalizedWhitelist ||
           normalized.endsWith('.' + normalizedWhitelist);
  });
}

function extractMagnetFromUrl(url) {
  if (!url || typeof url !== 'string') return null;
  const magnetRegex = /magnet:\?xt=urn:btih:[a-zA-Z0-9]{32,40}[^\s"]*/i;
  const match = url.match(magnetRegex);
  return match ? match[0] : null;
}

function extractMagnetHash(magnetLink) {
  if (!magnetLink || typeof magnetLink !== 'string') return null;
  const match = magnetLink.match(/xt=urn:btih:([a-zA-Z0-9]+)/i);
  return match ? match[1].toLowerCase() : null;
}

function validateMagnetLink(magnetLink) {
  if (!magnetLink || typeof magnetLink !== 'string') return false;
  const magnetRegex = /^magnet:\?xt=urn:btih:[a-zA-Z0-9]{32,40}/i;
  return magnetRegex.test(magnetLink);
}

function validateDomainFormat(domain) {
  if (!domain || typeof domain !== 'string') return false;
  const normalized = normalizeDomain(domain);
  if (!normalized) return false;
  const domainRegex = /^[a-zA-Z0-9]([a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(\.[a-zA-Z0-9]([a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)*$/;
  return domainRegex.test(normalized) &&
         normalized.length <= 253 &&
         !normalized.includes('..') &&
         !normalized.includes('@') &&
         !normalized.startsWith('.') &&
         !normalized.endsWith('.') &&
         normalized.split('.').every(label => label.length <= 63);
}

function cleanMagnetLink(magnetLink) {
  if (!magnetLink || typeof magnetLink !== 'string') return null;
  const baseMatch = magnetLink.match(/magnet:\?xt=urn:btih:[a-zA-Z0-9]{32,40}/i);
  if (!baseMatch) return null;
  const params = magnetLink.split('&');
  const allowedParams = ['xt', 'dn', 'tr', 'xl', 'as'];
  const filteredParams = params.filter(param => {
    const key = param.split('=')[0].replace('magnet:?', '');
    return allowedParams.includes(key);
  });
  return filteredParams.join('&');
}

async function updateWhitelistedDomains(domains) {
  try {
    if (!Array.isArray(domains)) return false;
    const validDomains = domains
      .map(domain => normalizeDomain(domain))
      .filter(domain => domain && validateDomainFormat(domain))
      .filter((domain, index, arr) => arr.indexOf(domain) === index);
    if (validDomains.length === 0) return false;
    WHITELISTED_DOMAINS = validDomains;
    DOMAINS_LOADED = true;
    await chrome.storage.local.set({ whitelistedDomains: WHITELISTED_DOMAINS });
    return true;
  } catch (error) {
    console.error('Error updating whitelisted domains:', error);
    return false;
  }
}

async function loadWhitelistedDomains() {
  try {
    const result = await chrome.storage.local.get(['whitelistedDomains']);
    if (result.whitelistedDomains && Array.isArray(result.whitelistedDomains)) {
      const validDomains = result.whitelistedDomains
        .map(domain => normalizeDomain(domain))
        .filter(domain => domain && validateDomainFormat(domain));
      WHITELISTED_DOMAINS = validDomains;
      if (validDomains.length !== result.whitelistedDomains.length) {
        await chrome.storage.local.set({ whitelistedDomains: WHITELISTED_DOMAINS });
      }
    }
    DOMAINS_LOADED = true;
    return WHITELISTED_DOMAINS;
  } catch (error) {
    console.error('Error loading whitelisted domains:', error);
    DOMAINS_LOADED = true;
    return WHITELISTED_DOMAINS;
  }
}

async function ensureDomainsLoaded() {
  if (!DOMAINS_LOADED) {
    await loadWhitelistedDomains();
  }
  return DOMAINS_LOADED;
}

function processBulkDomainInput(text) {
  if (!text || typeof text !== 'string') return [];
  return text
    .split(/[\n,;\s|]+/)
    .map(domain => domain.trim())
    .filter(domain => domain.length > 0)
    .map(domain => normalizeDomain(domain))
    .filter(domain => domain && validateDomainFormat(domain))
    .filter((domain, index, arr) => arr.indexOf(domain) === index);
}

async function detectCurrentTabDomain() {
  try {
    if (typeof chrome === 'undefined' || !chrome.tabs) {
      throw new Error('Chrome tabs API not available');
    }
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab || !tab.url) {
      throw new Error('No active tab or URL available');
    }
    const url = new URL(tab.url);
    const normalizedDomain = normalizeDomain(url.hostname);
    if (!normalizedDomain || !validateDomainFormat(normalizedDomain)) {
      throw new Error('Invalid domain detected');
    }
    return {
      domain: normalizedDomain,
      url: tab.url,
      title: tab.title
    };
  } catch (error) {
    console.error('Error detecting current tab domain:', error);
    throw error;
  }
}

function formatFileSize(bytes) {
  if (!bytes || bytes === 0) return '0 Bytes';
  const k = 1024;
  const sizes = ['Bytes', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
}

function sanitizeString(str) {
  if (!str || typeof str !== 'string') return '';
  return str.replace(/[<>'"&]/g, function(char) {
    const entities = { '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;', '&': '&amp;' };
    return entities[char] || char;
  });
}

if (typeof window !== 'undefined') {
  window.UtilsExtended = {
    normalizeDomain,
    validateDomainFormat,
    processBulkDomainInput,
    detectCurrentTabDomain,
    ensureDomainsLoaded
  };
}