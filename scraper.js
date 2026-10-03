const { chromium } = require('playwright-extra');
const stealth = require('puppeteer-extra-plugin-stealth')();
const axios = require('axios');
const cheerio = require('cheerio');

chromium.use(stealth);

// A rotating pool of realistic user agents
const USER_AGENTS = [
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36',
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:125.0) Gecko/20100101 Firefox/125.0',
    'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_4_1) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Safari/605.1.15',
];

function randomUA() {
    return USER_AGENTS[Math.floor(Math.random() * USER_AGENTS.length)];
}

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

function randomDelay(min = 1000, max = 3000) {
    return sleep(min + Math.random() * (max - min));
}

/**
 * The complete Google Maps Lead Scraper.
 * Uses stable ARIA/data-attribute selectors, click-into-detail approach,
 * proxy rotation, and enrichment.
 */
class GoogleMapsScraper {
    constructor(options = {}) {
        this.browser = null;
        this.context = null;
        this.proxies = options.proxies || [];
        this.currentProxyIndex = 0;
    }

    _getNextProxy() {
        if (this.proxies.length === 0) return null;
        const proxy = this.proxies[this.currentProxyIndex % this.proxies.length];
        this.currentProxyIndex++;
        return proxy;
    }

    async init() {
        let retries = Math.min(this.proxies.length + 1, 6); // Try proxies + 1 fallback
        let success = false;

        while (retries > 0 && !success) {
            const proxy = this._getNextProxy();
            const launchOptions = {
                headless: true,
                args: [
                    '--no-sandbox',
                    '--disable-setuid-sandbox',
                    '--disable-blink-features=AutomationControlled',
                    '--disable-infobars',
                    '--window-size=1400,800',
                    '--lang=en-US,en',
                ],
            };

            if (proxy) {
                console.log(`[Scraper] Initializing with proxy: ${proxy.server}`);
                launchOptions.proxy = {
                    server: proxy.server,
                    username: proxy.username,
                    password: proxy.password
                };
            } else {
                console.log(`[Scraper] Initializing with Local IP (No Proxy)`);
            }

            try {
                this.browser = await chromium.launch(launchOptions);
                this.context = await this.browser.newContext({
                    viewport: { width: 1400, height: 800 },
                    userAgent: randomUA(),
                    locale: 'en-US',
                    timezoneId: 'Asia/Kolkata',
                    permissions: [],
                    geolocation: undefined,
                });

                // Block ads/trackers
                await this.context.route('**/*.{png,jpg,jpeg,gif,svg,webp,ico,woff,woff2}', (route) => route.abort());
                await this.context.route('**/{analytics,doubleclick,googlesyndication}**', (route) => route.abort());
                
                success = true;
            } catch (e) {
                console.error(`[Scraper] Proxy failure (${retries} retries left): ${e.message}`);
                retries--;
                if (this.browser) await this.browser.close();
                if (retries === 0 && proxy) {
                    console.log(`[Scraper] All proxies failed. Final fallback to Local IP...`);
                    this.proxies = []; // Clear for local fallback
                    retries = 1;
                }
            }
        }

        if (!success) throw new Error('Failed to initialize scraper after multiple proxy retries.');
    }

    async close() {
        if (this.browser) await this.browser.close();
    }

    /**
     * Scrolls a feed container completely to load all results.
     */
    async _scrollFeedToEnd(page, progressCallback, maxLeads = Infinity, checkStop = () => false) {
        const feedSelector = 'div[role="feed"]';
        try {
            await page.waitForSelector(feedSelector, { timeout: 15000 });
        } catch (e) {
            return 0;
        }

        let prevCount = 0;
        let stuckCount = 0;

        while (stuckCount < 10) {
            if (checkStop()) break;
            
            // Check if we already have enough results loaded (Count by business links)
            const currentCount = await page.$$eval('a[href*="/maps/place/"]', els => els.length);
            if (currentCount >= maxLeads) break;

            // Check for "end of list" or other exhaustion markers
            const endOfList = await page.evaluate(() => {
                const textMarkers = ["Reached the end", "No more results", "No more businesses"];
                const spans = Array.from(document.querySelectorAll('p, span, div, h3'));
                return spans.some(el => el.innerText && textMarkers.some(m => el.innerText.includes(m)));
            });
            if (endOfList) break;

            // Scroll the feed (Deeper scroll)
            await page.evaluate(() => {
                const feed = document.querySelector('div[role="feed"]');
                if (feed) feed.scrollBy(0, 1200);
            });

            await randomDelay(1500, 2500);

            if (progressCallback) progressCallback(currentCount);

            if (currentCount === prevCount) {
                stuckCount++;
                // Aggressive scroll-to-bottom and wait more when stuck
                await page.evaluate(() => {
                    const feed = document.querySelector('div[role="feed"]');
                    if (feed) feed.scrollTo(0, feed.scrollHeight + 1000);
                });
                await randomDelay(3500, 5000);
            } else {
                prevCount = currentCount;
                stuckCount = 0;
            }
        }
        return await page.$$eval('a[href*="/maps/place/"]', els => els.length);
    }

    /**
     * Extracts ALL result listing cards from the sidebar.
     * Uses the "click each card" approach to get full details from the detail panel.
     */
    async _extractResults(page, progressCallback, maxLeads = Infinity, checkStop = () => false) {
        const results = [];
        const feedSelector = 'div[role="feed"]';
        
        // Get ALL links inside the feed that are business cards
        const links = await page.$$eval(`${feedSelector} a[href*="/maps/place/"]`, (els) => {
            const seen = new Set();
            return els.map(el => {
                const href = el.href;
                if (!seen.has(href) && href) {
                    seen.add(href);
                    return href;
                }
                return null;
            }).filter(Boolean);
        });

        // Remove duplicates and apply limit
        const uniqueLinks = [...new Set(links)].slice(0, maxLeads);

        for (let i = 0; i < uniqueLinks.length; i++) {
            if (checkStop() || results.length >= maxLeads) break;
            if (progressCallback) progressCallback({ status: 'extracting', current: i + 1, total: uniqueLinks.length });

            // ── Try up to 2 attempts per link (handles crashes and slow loads) ──
            let attempts = 0;
            let succeeded = false;

            while (attempts < 2 && !succeeded) {
                attempts++;
                let detailPage = null;

            try {
                // Navigate to each place detail page
                detailPage = await this.context.newPage();
                await detailPage.goto(uniqueLinks[i], { waitUntil: 'domcontentloaded', timeout: 30000 });

                // ───── STABILITY SYNC: Wait for the place name heading to appear ─────
                try {
                    await detailPage.waitForSelector('h1, .fontHeadlineLarge', { timeout: 8000 });
                } catch (e) {
                    // h1 didn't appear in time — page may be a redirect or error page, skip it
                    console.warn(`[Scraper] h1 not found on page ${i + 1}, skipping.`);
                    await detailPage.close().catch(() => {});
                    break; // Don't retry — not a crash, just a bad page
                }

                // Wait for URL to contain coordinates (geo-coding complete)
                let urlAtTime = detailPage.url();
                let retry = 0;
                while (!urlAtTime.includes('@') && retry < 10) {
                    await randomDelay(400, 600);
                    urlAtTime = detailPage.url();
                    retry++;
                }

                // Rating/reviews often hydrate a beat after the title — give them a chance
                await detailPage.waitForSelector(
                    '[role="img"][aria-label*="star" i], [aria-label*="star" i], [aria-label*="review" i]',
                    { timeout: 4000 }
                ).catch(() => {});
                await randomDelay(300, 600);

                const data = await detailPage.evaluate(() => {
                    const clean = (str) => {
                        if (!str) return '';
                        return str
                            .replace(/[\uE000-\uF8FF]/g, '') // Remove Google glyph icons
                            .replace(/\n+/g, ' ')           // Replace newlines with spaces
                            .replace(/\s{2,}/g, ' ')        // Collapse multiple spaces
                            .trim();
                    };

                    // Name: try h1 first, then common Google Maps fallbacks
                    const name = clean(
                        document.querySelector('h1')?.innerText ||
                        document.querySelector('.fontHeadlineLarge')?.innerText ||
                        document.querySelector('[data-attrid="title"]')?.innerText
                    ) || '';

                    // ── Rating + Reviews ──────────────────────────────────────────
                    // Prefer aria-label parsing. Avoid matching "Write a review" /
                    // "Sort reviews" buttons (old code used the first match +
                    // innerText, which left Reviews empty).
                    const reviewCountFromLabel = (label) => {
                        if (!label) return '';
                        const lower = label.toLowerCase();
                        if (lower.includes('write a review') || lower.includes('sort review') || lower.includes('add a review')) {
                            return '';
                        }
                        const m = label.match(/([\d,]+)\s*reviews?/i);
                        return m ? m[1].replace(/,/g, '') : '';
                    };

                    const ratingFromLabel = (label) => {
                        if (!label) return '';
                        const m = label.match(/([\d.]+)\s*stars?/i)
                            || label.match(/rated\s+([\d.]+)/i)
                            || label.match(/^([\d.]+)$/);
                        if (!m) return '';
                        const n = parseFloat(m[1]);
                        return (n >= 0 && n <= 5) ? String(m[1]) : '';
                    };

                    let rating = '';
                    let reviews = '';

                    // Scope to the place panel (near h1) so map pins / other UI don't leak in
                    const h1 = document.querySelector('h1');
                    const placeRoot =
                        h1?.closest('[role="main"]') ||
                        h1?.parentElement?.parentElement?.parentElement ||
                        document.body;

                    // 1) Combined / dedicated aria-labels in the place panel
                    const labeled = Array.from(placeRoot.querySelectorAll('[aria-label]'));
                    for (const el of labeled) {
                        const label = el.getAttribute('aria-label') || '';
                        if (!rating) {
                            const r = ratingFromLabel(label);
                            if (r) rating = r;
                        }
                        if (!reviews) {
                            const c = reviewCountFromLabel(label);
                            if (c) reviews = c;
                        }
                        if (rating && reviews) break;
                    }

                    // 2) Visible "(1,234)" next to the rating stars
                    if (!reviews) {
                        const starImg = placeRoot.querySelector('[role="img"][aria-label*="star" i], [aria-label*="stars" i]');
                        const nearby = starImg?.closest('div, button, a, span')?.parentElement;
                        const nearbyText = nearby?.innerText || '';
                        const paren = nearbyText.match(/\(([\d,]+)\)/);
                        if (paren) reviews = paren[1].replace(/,/g, '');
                    }

                    // 3) Fallback: numeric rating text under the title
                    if (!rating) {
                        const header = h1?.parentElement?.parentElement || placeRoot;
                        const candidates = Array.from(header.querySelectorAll('span, div')).slice(0, 80);
                        for (const el of candidates) {
                            const t = (el.innerText || '').trim();
                            if (/^\d\.\d$/.test(t)) {
                                rating = t;
                                break;
                            }
                        }
                    }

                    // Category
                    const catEl = document.querySelector('button[jsaction*="category"]') || document.querySelector('span.mgr77e');
                    const category = clean(catEl?.innerText) || '';

                    // Address
                    const addrEl = document.querySelector('[data-item-id="address"]') 
                        || document.querySelector('button[aria-label*="Address"]');
                    const address = clean(addrEl?.innerText) || '';

                    // Phone
                    const phoneEl = document.querySelector('[data-item-id^="phone:tel:"]')
                        || document.querySelector('button[aria-label*="Phone"]');
                    const phone = clean(phoneEl?.innerText) || '';

                    // Website
                    const webEl = document.querySelector('a[data-item-id="authority"]') 
                        || document.querySelector('a[aria-label*="website" i]');
                    const website = webEl ? webEl.href : '';

                    // ───── NEW SMART COLUMNS ─────

                    // 1. Verification Status (Claimed/Unclaimed)
                    const isUnclaimed = !!(
                        document.querySelector('a[href*="/enroll"]') || 
                        document.querySelector('button[aria-label*="Claim this business"]') ||
                        document.querySelector('button[aria-label*="Own this business"]')
                    );
                    const verification = isUnclaimed ? 'Unclaimed' : 'Claimed';

                    // 2. Opening Hours (Flexible selector hunt)
                    const hoursEl = document.querySelector('[data-item-id="oloc"]') 
                        || document.querySelector('button[aria-label*="hours" i]')
                        || Array.from(document.querySelectorAll('div')).find(el => el.innerText && el.innerText.includes('Close ⋅ Opens'));
                    const hours = hoursEl ? clean(hoursEl.innerText) : 'Not available';

                    // 3. Amenities / Tags (Broader hunt)
                    const tagEls = Array.from(document.querySelectorAll('div.iP2En span, .Pb79N, button.S9kvJc, .m6QErb .ZKCDEc'));
                    const tags = [...new Set(tagEls.map(el => clean(el.innerText)).filter(t => t.length > 2))].join(', ');

                    // 4. Coordinates (Lat/Long from URL)
                    const currentUrl = window.location.href;
                    const coordMatch = currentUrl.match(/@(-?\d+\.\d+),(-?\d+\.\d+)/);
                    const lat = coordMatch ? coordMatch[1] : '';
                    const lng = coordMatch ? coordMatch[2] : '';

                    // 5. Maps-Panel Social Links (Bonus)
                    const panelSocialsArray = Array.from(document.querySelectorAll('a[href*="instagram.com"], a[href*="facebook.com"], a[href*="linkedin.com"]'))
                        .map(a => a.href);
                    const panelSocials = [...new Set(panelSocialsArray)].join(', ');

                    // Google Maps URL (current page)
                    const mapsUrl = currentUrl.split('?')[0];

                    return { 
                        name, rating, reviews, category, address, phone, website, mapsUrl,
                        verification, hours, tags, lat, lng, panelSocials
                    };
                });

                if (data.name) {
                    // ───── Smart Address Splitting (Server-side / India focus) ─────
                    const addr = data.address || '';
                    
                    // Match 6-digit PIN code (India)
                    const pinMatch = addr.match(/(\d{6})/);
                    data.zip = pinMatch ? pinMatch[1] : '';

                    // Match State (India - common states)
                    const states = ['Uttar Pradesh', 'Delhi', 'Maharashtra', 'Karnataka', 'Tamil Nadu', 'West Bengal', 'Gujarat', 'Rajasthan', 'Punjab', 'Haryana', 'Bihar', 'Madhya Pradesh'];
                    const stateMatch = states.find(s => addr.toLowerCase().includes(s.toLowerCase()));
                    data.state = stateMatch || '';

                    results.push(data);
                    succeeded = true;
                } else {
                    console.warn(`[Scraper] ⚠️ Skipped lead ${i + 1} — name was empty. URL: ${uniqueLinks[i].substring(0, 80)}`);
                    succeeded = true; // Bad page but not a crash — don't retry
                }

                await detailPage.close().catch(() => {});
                await randomDelay(800, 1800);

            } catch (err) {
                // Always guarantee tab is closed — even on Target crashed
                if (detailPage) {
                    await detailPage.close().catch(() => {});
                }

                const msg = err?.message || '';
                const isCrash = msg.includes('Target crashed') || msg.includes('target crashed') || msg.includes('crashed');
                const isTimeout = msg.includes('Timeout') || msg.includes('Navigation timeout');

                if ((isCrash || isTimeout) && attempts < 2) {
                    const reason = isTimeout ? 'timed out' : 'crashed';
                    console.warn(`[Scraper] ⚠️ Lead ${i + 1} ${reason}. Retrying once... (${msg})`);
                    await randomDelay(1500, 2500); // Brief pause before retry
                } else {
                    console.error(`[Scraper] Skipped lead ${i + 1}: ${msg}`);
                    succeeded = true; // Mark as handled so we move to next lead
                }
            }

            } // end while (attempts < 2)
        }

        return results;
    }

    /**
     * Full search: load feed -> scroll to end -> extract details from each result.
     */
    async search(query, progressCallback, maxLeads = Infinity, checkStop = () => false) {
        const page = await this.context.newPage();
        const url = `https://www.google.com/maps/search/${encodeURIComponent(query)}`;
        console.log(`[Scraper] Searching: ${url}`);

        try {
            await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
            await randomDelay(1500, 2500);
        } catch (e) {
            console.error(`[Scraper] Page load failed: ${e.message}`);
            await page.close();
            return [];
        }

        if (checkStop()) { await page.close(); return []; }

        // Dismiss any consent or cookie dialog
        try {
            for (const sel of ['button[aria-label="Accept all"]', 'button[aria-label*="Accept"]', 'button[aria-label*="Reject"]']) {
                const btn = await page.$(sel);
                if (btn) { await btn.click(); break; }
            }
        } catch (e) {}

        await randomDelay(1000, 2000);

        // Scroll feed to load all results (or until maxLeads is met or stop signaled)
        await this._scrollFeedToEnd(page, (count) => {
            if (progressCallback) progressCallback({ status: 'scrolling', count: count });
        }, maxLeads, checkStop);

        if (checkStop()) { await page.close(); return []; }

        const results = await this._extractResults(page, progressCallback, maxLeads, checkStop);

        if (results.length === 0) {
            const title = await page.title();
            console.log(`[Scraper] ⚠️ 0 leads found for "${query}". Page Title: "${title}"`);
            if (title.toLowerCase().includes('robot') || title.toLowerCase().includes('captcha')) {
                console.error(`[Scraper] 🔥 Google is showing a CAPTCHA. This IP might be flagged.`);
            }
        }

        await page.close();
        return results;
    }

    /**
     * Grid Search: Extract leads with an optional limit and stop signal.
     */
    async gridSearch(businessType, city, country, progressCallback, areaList = [], maxLeads = Infinity, checkStop = () => false) {
        const allLeads = new Map(); // key: name+phone -> lead (for dedup)

        const addLeads = (leads) => {
            for (const lead of leads) {
                if (allLeads.size >= maxLeads) break;
                const key = `${lead.name}|${lead.phone || lead.address}`;
                if (!allLeads.has(key)) {
                    allLeads.set(key, lead);
                }
            }
        };

        // Phase Runner: Processes a group of queries and reports them as distinct sub-phases
        const runPhase = async (phaseNumber, phaseTitle, queries) => {
            const letters = 'abcdefghijklmnopqrstuvwxyz';
            for (let i = 0; i < queries.length; i++) {
                if (checkStop() || allLeads.size >= maxLeads) break;
                
                const query = queries[i];
                // Use 1, 2(a), 2(b) etc. style as requested
                const phaseLabel = queries.length > 1 ? `${phaseNumber}(${letters[i]})` : `${phaseNumber}`;
                const phaseName = `${phaseLabel}. ${phaseTitle}${queries.length > 1 ? ` (${directions[i] || i+1})` : ''}`;

                if (progressCallback) progressCallback({ 
                    phase: phaseName, 
                    query: query, 
                    totalUnique: allLeads.size,
                    step: `${i + 1}/${queries.length}`
                });
                
                const remaining = maxLeads - allLeads.size;
                const leads = await this.search(query, (data) => {
                    if (progressCallback) progressCallback({ 
                        ...data, 
                        phase: phaseName, 
                        query: query, 
                        totalUnique: allLeads.size 
                    });
                }, remaining, checkStop);
                
                addLeads(leads);
                await randomDelay(2000, 4000);
            }
        };

        const directions = ['North', 'South', 'East', 'West', 'Central', 'Old'];

        await runPhase(1, '🔍 Discovery', [`${businessType} in ${city}, ${country}`]);

        const dirQueries = directions.map(dir => `${businessType} in ${dir} ${city}, ${country}`);
        await runPhase(2, '🧭 Regional', dirQueries);

        if (areaList.length > 0) {
            const areaQueries = areaList.map(area => `${businessType} in ${area}, ${city}, ${country}`);
            await runPhase(3, '📌 Neighborhood', areaQueries);
        }

        if (progressCallback) progressCallback({ status: 'complete', phase: '🏁 Search Finished', totalUnique: allLeads.size });
        return Array.from(allLeads.values());
    }

    /**
     * Enriches a business with email and social links by visiting their website.
     */
    async enrich(business) {
        // Initialize socials with those found directly on the Maps panel
        const initialSocials = business.panelSocials ? business.panelSocials.split(', ') : [];
        
        if (!business.website || business.website.includes('google.com')) {
            business.email = '';
            business.socials = initialSocials.join(', ');
            return business;
        }

        try {
            const response = await axios.get(business.website, {
                timeout: 10000,
                maxRedirects: 3,
                headers: {
                    'User-Agent': randomUA(),
                    'Accept': 'text/html,application/xhtml+xml',
                },
            });

            const $ = cheerio.load(response.data);

            // Extract emails
            const htmlSource = response.data;
            const emailRegex = /[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}/g;
            const emails = [...new Set(htmlSource.match(emailRegex) || [])].filter(e => !e.endsWith('.png') && !e.endsWith('.jpg'));

            business.email = emails.length > 0 ? emails[0] : '';
            business.allEmails = emails.join(', ');

            // Extract social media links from website
            const socialPatterns = ['facebook.com', 'instagram.com', 'linkedin.com', 'twitter.com', 'x.com', 'youtube.com'];
            const websiteSocials = [];
            $('a[href]').each((i, el) => {
                const href = $(el).attr('href') || '';
                if (socialPatterns.some(pattern => href.includes(pattern))) {
                    websiteSocials.push(href);
                }
            });
            
            // Merge maps panel socials with website socials
            const mergedSocials = [...new Set([...initialSocials, ...websiteSocials])];
            business.socials = mergedSocials.join(', ');

        } catch (e) {
            business.email = '';
            business.socials = initialSocials.join(', '); // Keep maps panel socials on error
        }

        return business;
    }
}

module.exports = GoogleMapsScraper;
