#!/usr/bin/env node

import { readFile, writeFile } from 'fs/promises';
import { existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const STATE_PATH = join(SCRIPT_DIR, '..', 'state-feed.json');
const SOURCES_PATH = join(SCRIPT_DIR, '..', 'config', 'default-sources.json');
const DEFAULT_LOOKBACK_HOURS = 168;
const DEFAULT_TIMEOUT_MS = 15000;
const USER_AGENT = 'USTCDailyNews/1.0 (digest aggregator)';

const CATEGORY_DEFS = [
  { key: 'official', file: 'feed-official.json', statsKey: 'officialItems' },
  { key: 'departments', file: 'feed-departments.json', statsKey: 'departmentItems' },
  { key: 'jobs', file: 'feed-jobs.json', statsKey: 'jobItems' },
  { key: 'tech', file: 'feed-tech.json', statsKey: 'techItems' },
  { key: 'papers', file: 'feed-papers.json', statsKey: 'paperItems' }
];

const DEFAULT_SECTION_KEYWORDS = [
  '通知公告',
  '学院新闻',
  '学部新闻',
  '系内新闻',
  '新闻中心',
  '综合新闻',
  '学术活动',
  '学术报告',
  '教务通知',
  '学生工作',
  '就业公告',
  '招聘',
  '宣讲会'
];

function parseArgs(argv) {
  const args = { validate: false, reportPath: null };
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === '--validate') {
      args.validate = true;
    } else if (token === '--report' && argv[index + 1]) {
      args.reportPath = argv[index + 1];
      index += 1;
    }
  }
  if (!args.reportPath && args.validate) {
    args.reportPath = join(SCRIPT_DIR, '..', 'source-validation-report.json');
  }
  return args;
}

async function loadState() {
  if (!existsSync(STATE_PATH)) {
    return { seenItems: {} };
  }
  try {
    const state = JSON.parse(await readFile(STATE_PATH, 'utf-8'));
    return { seenItems: state.seenItems || {} };
  } catch {
    return { seenItems: {} };
  }
}

async function saveState(state) {
  const cutoff = Date.now() - 14 * 24 * 60 * 60 * 1000;
  for (const [id, ts] of Object.entries(state.seenItems)) {
    if (ts < cutoff) delete state.seenItems[id];
  }
  await writeFile(STATE_PATH, JSON.stringify(state, null, 2));
}

async function loadSources() {
  return JSON.parse(await readFile(SOURCES_PATH, 'utf-8'));
}

function toIsoDateOrNull(value) {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function decodeHtml(text) {
  return String(text || '')
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/&#x([0-9a-f]+);/gi, (_, hex) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, num) => String.fromCodePoint(parseInt(num, 10)))
    .trim();
}

function stripTags(html) {
  return decodeHtml(String(html || ''))
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/[\u200b\ufeff]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function escapeRegExp(value) {
  return String(value || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function cleanTitle(title, sourceName = '') {
  let cleaned = stripTags(title)
    .replace(/\s*[:：|-]\s*中国科学技术大学教务处$/i, '')
    .replace(/\s*[-|—]\s*中国科大新闻网$/i, '')
    .replace(/\s*[-|—]\s*中国科学技术大学新闻网$/i, '')
    .replace(/\s+/g, ' ')
    .trim();

  if (sourceName) {
    const suffix = new RegExp(`\\s*[-|—|｜|·]\\s*${escapeRegExp(sourceName)}$`, 'i');
    cleaned = cleaned.replace(suffix, '').trim();
  }

  return cleaned;
}

function parseRssFeed(xml) {
  const items = [];
  const itemRegex = /<item>([\s\S]*?)<\/item>/gi;
  let itemMatch;
  while ((itemMatch = itemRegex.exec(xml)) !== null) {
    const block = itemMatch[1];
    const titleMatch = block.match(/<title>([\s\S]*?)<\/title>/i);
    const linkMatch = block.match(/<link>([\s\S]*?)<\/link>/i);
    const guidMatch = block.match(/<guid[^>]*>([\s\S]*?)<\/guid>/i);
    const pubDateMatch = block.match(/<pubDate>([\s\S]*?)<\/pubDate>/i);
    const descMatch = block.match(/<description>([\s\S]*?)<\/description>/i);
    const title = titleMatch ? decodeHtml(titleMatch[1]) : 'Untitled';
    const url = linkMatch ? decodeHtml(linkMatch[1]) : null;
    const guid = guidMatch ? decodeHtml(guidMatch[1]) : url || title;
    const publishedAt = pubDateMatch ? toIsoDateOrNull(decodeHtml(pubDateMatch[1])) : null;
    const summary = descMatch ? stripTags(descMatch[1]) : '';
    if (url || guid) {
      items.push({ title, url, guid, publishedAt, summary });
    }
  }
  return items;
}

function parseAtomFeed(xml) {
  const entries = [];
  const entryRegex = /<entry>([\s\S]*?)<\/entry>/gi;
  let entryMatch;
  while ((entryMatch = entryRegex.exec(xml)) !== null) {
    const block = entryMatch[1];
    const titleMatch = block.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
    const idMatch = block.match(/<id>([\s\S]*?)<\/id>/i);
    const updatedMatch = block.match(/<updated>([\s\S]*?)<\/updated>/i);
    const summaryMatch = block.match(/<summary[^>]*>([\s\S]*?)<\/summary>/i) || block.match(/<content[^>]*>([\s\S]*?)<\/content>/i);
    const linkMatch = block.match(/<link[^>]*href="([^"]+)"[^>]*\/?/i);
    const title = titleMatch ? decodeHtml(titleMatch[1]) : 'Untitled';
    const url = linkMatch ? decodeHtml(linkMatch[1]) : null;
    const guid = idMatch ? decodeHtml(idMatch[1]) : url || title;
    const publishedAt = updatedMatch ? toIsoDateOrNull(decodeHtml(updatedMatch[1])) : null;
    const summary = summaryMatch ? stripTags(summaryMatch[1]) : '';
    if (url || guid) {
      entries.push({ title, url, guid, publishedAt, summary });
    }
  }
  return entries;
}

function withinLookback(item, hours) {
  if (!item?.publishedAt) return true;
  const timestamp = new Date(item.publishedAt).getTime();
  if (Number.isNaN(timestamp)) return true;
  const cutoff = Date.now() - hours * 60 * 60 * 1000;
  return timestamp >= cutoff;
}

function absolutizeUrl(baseUrl, maybeRelative) {
  try {
    return new URL(maybeRelative, baseUrl).toString();
  } catch {
    return maybeRelative;
  }
}

function compilePattern(pattern) {
  if (!pattern) return null;
  try {
    return new RegExp(pattern, 'i');
  } catch {
    return null;
  }
}

function normalizeDateString(value) {
  if (!value) return null;
  const match = String(value).match(/(20\d{2})\s*[-/.年]\s*(0?[1-9]|1[0-2])\s*[-/.月]\s*(3[01]|[12]\d|0?[1-9])/);
  if (!match) return null;
  const [, year, month, day] = match;
  return `${year}-${month.padStart(2, '0')}-${day.padStart(2, '0')}`;
}

function extractDate(text) {
  return normalizeDateString(text);
}

function extractPreferredDate(html, regexes) {
  for (const regex of regexes) {
    const match = html.match(regex);
    if (match?.[1]) {
      const normalized = normalizeDateString(match[1]);
      if (normalized) return normalized;
    }
  }
  return null;
}

function isLowValueTitle(title) {
  return /联系方式|办公地点|常见问题|工作手册|报修|入口|下载|登录|服务指南|平台说明|系统说明|搜索|首页|上一页|下一页|专题|附件|更多/i.test(title);
}

function isLikelyNoise(content) {
  return /搜索热点|友情链接|版权所有|上一篇|下一篇|微信扫一扫|投稿|English|主站|通知新闻|服务指南/.test(content);
}

function looksLikeArticleUrl(url = '') {
  return /\/20\d{2}\/.+(?:page\.htm|\.html?|\.shtml)$|info\/\d+\/\d+\.(?:htm|html)$|itemid=\d+/i.test(url);
}

function scoreKeywordHits(text, keywords = []) {
  const normalized = String(text || '');
  let score = 0;
  for (const keyword of keywords) {
    if (keyword && normalized.includes(keyword)) {
      score += 1;
    }
  }
  return score;
}

function passesSourceFilters(item, source) {
  const allowPattern = compilePattern(source.urlAllowPattern);
  const denyPattern = compilePattern(source.urlDenyPattern);
  const url = item.url || '';
  const title = cleanTitle(item.title || '', source.name);
  if (!url || !title) return false;
  if (allowPattern && !allowPattern.test(url)) return false;
  if (denyPattern && denyPattern.test(url)) return false;
  if (title.length < 6) return false;
  if (title.length > 80) return false;
  if (isLowValueTitle(title)) return false;
  return true;
}

function dedupeCandidates(items) {
  const seen = new Set();
  const deduped = [];
  for (const item of items) {
    const key = item.url || item.guid || item.title;
    if (!key || seen.has(key)) continue;
    seen.add(key);
    deduped.push(item);
  }
  return deduped;
}

function scoreCandidate(title, url, nearbyText, source) {
  let score = 0;
  const sectionKeywords = [...DEFAULT_SECTION_KEYWORDS, ...(source.sectionKeywords || [])];
  if (extractDate(nearbyText)) score += 5;
  score += scoreKeywordHits(title, ['通知', '公告', '新闻', '讲座', '报告', '招聘', '宣讲', '活动', '论坛', '会议']) * 2;
  score += scoreKeywordHits(nearbyText, sectionKeywords) * 2;
  if (looksLikeArticleUrl(url)) score += 4;
  if (title.length >= 8 && title.length <= 40) score += 2;
  if (source.urlAllowPattern && compilePattern(source.urlAllowPattern)?.test(url)) score += 3;
  return score;
}

function parseScoredLinks(html, source, options = {}) {
  const items = [];
  const windowSize = options.windowSize || 480;
  const minScore = options.minScore || 6;
  const limitMultiplier = options.limitMultiplier || 6;
  const regex = /<a[^>]+href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi;
  let match;
  while ((match = regex.exec(html)) !== null) {
    const url = absolutizeUrl(source.siteUrl || source.indexUrl, decodeHtml(match[1]));
    const title = cleanTitle(match[2], source.name);
    const nearbyHtml = html.slice(Math.max(0, match.index - windowSize), Math.min(html.length, match.index + windowSize));
    const nearbyText = stripTags(nearbyHtml);
    const publishedAt = extractDate(nearbyText);
    const candidateScore = scoreCandidate(title, url, nearbyText, source);
    items.push({ title, url, guid: url, publishedAt, summary: '', candidateScore });
  }

  return dedupeCandidates(items)
    .filter(item => passesSourceFilters(item, source))
    .filter(item => (item.candidateScore || 0) >= minScore)
    .sort((a, b) => {
      if ((b.candidateScore || 0) !== (a.candidateScore || 0)) return (b.candidateScore || 0) - (a.candidateScore || 0);
      if (a.publishedAt && b.publishedAt) return new Date(b.publishedAt) - new Date(a.publishedAt);
      if (a.publishedAt) return -1;
      if (b.publishedAt) return 1;
      return 0;
    })
    .slice(0, (source.maxItems || 6) * limitMultiplier);
}

function parseTeachNoticeLinks(html, source) {
  return parseScoredLinks(html, source, { windowSize: 260, minScore: 4, limitMultiplier: 5 });
}

function parseUstcNewsLinks(html, source) {
  return parseScoredLinks(html, source, { windowSize: 360, minScore: 6, limitMultiplier: 6 })
    .filter(item => /中国科大|中国科学技术大学|实验室|团队|学院|学生|教授|研究|论坛|会议|成果|获奖|举办|开展|发布/.test(item.title));
}

function parseUstcDepartmentHomeLinks(html, source) {
  return parseScoredLinks(html, source, { windowSize: 640, minScore: 8, limitMultiplier: 8 });
}

function parseUstcJobLinks(html, source) {
  return parseScoredLinks(html, source, { windowSize: 720, minScore: 9, limitMultiplier: 10 });
}

function extractFirst(html, regexes) {
  for (const regex of regexes) {
    const match = html.match(regex);
    if (match?.[1]) return match[1];
  }
  return '';
}

function extractGenericArticle(html, source) {
  const title = cleanTitle(extractFirst(html, [
    /<meta[^>]+property="og:title"[^>]+content="([^"]+)"/i,
    /<meta[^>]+name="Title"[^>]+content="([^"]+)"/i,
    /<title>([\s\S]*?)<\/title>/i,
    /<h1[^>]*>([\s\S]*?)<\/h1>/i
  ]), source.name) || 'Untitled';

  const publishedAt = source.siteUrl?.includes('teach.ustc.edu.cn')
    ? extractPreferredDate(html, [
      /(?:发布时间|发布日期|日期|时间)[^0-9]{0,40}(20\d{2}\s*[-/.年]\s*(?:0?[1-9]|1[0-2])\s*[-/.月]\s*(?:3[01]|[12]\d|0?[1-9]))/i,
      /<div[^>]+class="[^"]*post-meta-print[^"]*"[^>]*>[\s\S]*?(20\d{2}[^\d]{0,2}\d{1,2}[^\d]{0,2}\d{1,2})/i,
      /<i[^>]+fa-clock-o[^>]*><\/i>\s*(20\d{2}[^\d]{0,2}\d{1,2}[^\d]{0,2}\d{1,2})/i,
      /<time[^>]*>([\s\S]*?)<\/time>/i
    ])
    : source.siteUrl?.includes('news.ustc.edu.cn')
      ? extractPreferredDate(html, [
        /(?:发布时间|发布日期|日期|时间)[^0-9]{0,40}(20\d{2}\s*[-/.年]\s*(?:0?[1-9]|1[0-2])\s*[-/.月]\s*(?:3[01]|[12]\d|0?[1-9]))/i,
        /(?:发布时间|日期)[：:\s]*<[^>]*>(20\d{2}[^\d]{0,2}\d{1,2}[^\d]{0,2}\d{1,2})/i,
        /(?:发布时间|日期)[：:\s]*(20\d{2}[^\d]{0,2}\d{1,2}[^\d]{0,2}\d{1,2})/i,
        /<time[^>]*>([\s\S]*?)<\/time>/i
      ])
      : extractPreferredDate(html, [
        /(?:发布时间|发布日期|日期|时间)[^0-9]{0,40}(20\d{2}\s*[-/.年]\s*(?:0?[1-9]|1[0-2])\s*[-/.月]\s*(?:3[01]|[12]\d|0?[1-9]))/i,
        /<time[^>]*>([\s\S]*?)<\/time>/i,
        /class="[^"]*(?:date|time|post-meta)[^"]*"[^>]*>([\s\S]*?)<\/[^>]+>/i,
        /发布时间[：:\s]*<[^>]*>([\s\S]*?)<\/[^>]+>/i,
        /发布时间[：:\s]*([^<\n]+)/i,
        /(20\d{2}\s*[-/.年]\s*(?:0?[1-9]|1[0-2])\s*[-/.月]\s*(?:3[01]|[12]\d|0?[1-9]))/
      ]);

  const contentHtml = extractFirst(html, [
    /<div[^>]+class="[^"]*(?:v_news_content|wp_articlecontent|entry-content|post-content|article-content|content-main|news-content|detail-content|detail_content|detail-txt|Article_Content|article-detail|wp_entry)[^"]*"[^>]*>([\s\S]*?)<\/div>/i,
    /<div[^>]+id="[^"]*(?:content|vsb_content|article|zoom|zoomcon|zoomCon)[^"]*"[^>]*>([\s\S]*?)<\/div>/i,
    /<article[^>]*>([\s\S]*?)<\/article>/i,
    /<body[^>]*>([\s\S]*?)<\/body>/i
  ]);

  const metaDescription = stripTags(extractFirst(html, [
    /<meta[^>]+name="description"[^>]+content="([^"]+)"/i,
    /<meta[^>]+property="og:description"[^>]+content="([^"]+)"/i
  ]));

  let content = stripTags(contentHtml)
    .replace(/上一篇.*$/i, ' ')
    .replace(/下一篇.*$/i, ' ')
    .replace(/责任编辑.*$/i, ' ')
    .replace(/打印\s+关闭.*$/i, ' ')
    .replace(/版权所有.*$/i, ' ')
    .trim();

  if (content.length < 80 && metaDescription) {
    content = metaDescription;
  }

  return { title, publishedAt, content, sourceName: source.name };
}

function isHighValueArticle(article, source) {
  if (!article.title || article.title.length < 6) return false;
  if (isLowValueTitle(article.title)) return false;
  if (!article.content || article.content.length < (source.category === 'jobs' ? 50 : 80)) return false;
  if (isLikelyNoise(article.content.slice(0, 240))) return false;
  if (article.content.replace(/\s+/g, '').startsWith(article.title.replace(/\s+/g, '')) && article.content.length < 120) return false;
  if (['official', 'departments', 'jobs'].includes(source.category) && !article.publishedAt && article.content.length < 150) return false;
  return true;
}

function scoreArticle(article, source) {
  let score = 0;
  if (article.publishedAt) score += 5;
  score += Math.min(article.content.length, 1200) / 100;
  if (/通知|公告|报名|答辩|选课|考试|申请|公示|课程|教学|招聘|宣讲/.test(article.title)) score += 3;
  if (/中国科大|中国科学技术大学|教授|学生|团队|学院|研究|成果|论坛|会议|举办|发布/.test(article.title)) score += 2;
  if (source.category === 'jobs') score += 1;
  return score;
}

function normalizeErrorMessage(error) {
  if (!error) return 'Unknown error';
  if (error.name === 'TimeoutError') return `Request timed out after ${DEFAULT_TIMEOUT_MS}ms`;
  return error.message || String(error);
}

async function fetchResponse(url) {
  return fetch(url, {
    headers: { 'User-Agent': USER_AGENT },
    signal: AbortSignal.timeout(DEFAULT_TIMEOUT_MS)
  });
}

function makeUniqueId(source, rawId) {
  return `${source.category}:${source.name}:${rawId}`;
}

function initSourceReport(source) {
  return {
    name: source.name,
    category: source.category,
    type: source.type,
    indexUrl: source.indexUrl || source.feedUrl,
    status: 'ok',
    candidateCount: 0,
    selectedCount: 0,
    skippedSeen: 0,
    sampleTitles: [],
    warnings: []
  };
}

function markSeen(state, uniqueId, enabled) {
  if (enabled) {
    state.seenItems[uniqueId] = Date.now();
  }
}

async function fetchFeedItems(source, state, options) {
  const report = initSourceReport(source);
  const res = await fetchResponse(source.feedUrl);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const xml = await res.text();
  const items = source.type === 'atom' ? parseAtomFeed(xml) : parseRssFeed(xml);
  const lookbackHours = source.lookbackHours || DEFAULT_LOOKBACK_HOURS;
  const maxItems = source.maxItems || 5;

  report.candidateCount = items.length;

  const selected = [];
  for (const item of items) {
    const uniqueId = makeUniqueId(source, item.guid || item.url || item.title);
    if (!uniqueId) continue;
    if (options.useState && state.seenItems[uniqueId]) {
      report.skippedSeen += 1;
      continue;
    }
    if (!withinLookback(item, lookbackHours)) continue;

    selected.push({
      source: source.category,
      sourceName: source.name,
      departmentName: source.departmentName || undefined,
      title: cleanTitle(item.title, source.name),
      url: item.url,
      publishedAt: item.publishedAt,
      summary: item.summary
    });

    markSeen(state, uniqueId, options.updateState);
    if (selected.length >= maxItems) break;
  }

  report.selectedCount = selected.length;
  report.status = selected.length > 0 ? 'ok' : 'empty';
  report.sampleTitles = selected.slice(0, 3).map(item => item.title);

  return { items: selected, report };
}

const LIST_PARSERS = {
  teach_notice_links: parseTeachNoticeLinks,
  ustc_news_links: parseUstcNewsLinks,
  ustc_department_home_links: parseUstcDepartmentHomeLinks,
  ustc_job_links: parseUstcJobLinks
};

async function fetchScrapeItems(source, state, options) {
  const report = initSourceReport(source);
  const res = await fetchResponse(source.indexUrl);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const html = await res.text();

  const parser = LIST_PARSERS[source.listParser];
  if (!parser) {
    throw new Error(`Unknown list parser: ${source.listParser}`);
  }

  const candidates = parser(html, source);
  report.candidateCount = candidates.length;

  const shortlisted = candidates.slice(0, Math.max((source.maxItems || 5) * 4, 8));
  const evaluated = [];

  for (const item of shortlisted) {
    const uniqueId = makeUniqueId(source, item.guid || item.url || item.title);
    if (!uniqueId) continue;
    if (options.useState && state.seenItems[uniqueId]) {
      report.skippedSeen += 1;
      continue;
    }

    let article = {
      title: cleanTitle(item.title, source.name),
      publishedAt: item.publishedAt || null,
      content: item.summary || ''
    };

    if (source.contentMode === 'article' && item.url) {
      try {
        const articleRes = await fetchResponse(item.url);
        if (!articleRes.ok) {
          report.warnings.push(`${item.url}: HTTP ${articleRes.status}`);
          continue;
        }
        const articleHtml = await articleRes.text();
        article = extractGenericArticle(articleHtml, source);
        if (!article.publishedAt) article.publishedAt = item.publishedAt || null;
      } catch (error) {
        report.warnings.push(`${item.url}: ${normalizeErrorMessage(error)}`);
        continue;
      }
    }

    if (!article.title || article.title === source.name || /就业信息网$/.test(article.title)) {
      article.title = cleanTitle(item.title, source.name);
    }

    if (!isHighValueArticle(article, source)) continue;
    if (!withinLookback({ publishedAt: article.publishedAt }, source.lookbackHours || DEFAULT_LOOKBACK_HOURS)) continue;

    evaluated.push({
      uniqueId,
      score: scoreArticle(article, source) + (item.candidateScore || 0),
      item: {
        source: source.category,
        sourceName: source.name,
        departmentName: source.departmentName || undefined,
        title: article.title || cleanTitle(item.title, source.name),
        url: item.url,
        publishedAt: article.publishedAt,
        summary: article.content
      }
    });
  }

  evaluated.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    if (a.item.publishedAt && b.item.publishedAt) return new Date(b.item.publishedAt) - new Date(a.item.publishedAt);
    if (a.item.publishedAt) return -1;
    if (b.item.publishedAt) return 1;
    return 0;
  });

  const selected = evaluated.slice(0, source.maxItems || 5);
  for (const entry of selected) {
    markSeen(state, entry.uniqueId, options.updateState);
  }

  report.selectedCount = selected.length;
  report.status = selected.length > 0 ? 'ok' : 'empty';
  report.sampleTitles = selected.slice(0, 3).map(entry => entry.item.title);

  return { items: selected.map(entry => entry.item), report };
}

async function fetchSourceItems(source, state, options) {
  if (source.type === 'rss' || source.type === 'atom') {
    return fetchFeedItems(source, state, options);
  }
  if (source.type === 'scrape') {
    return fetchScrapeItems(source, state, options);
  }
  throw new Error(`Unsupported source type: ${source.type}`);
}

async function fetchCategoryContent(sources, state, options, errors) {
  const results = [];
  const reports = [];

  for (const source of sources) {
    try {
      const { items, report } = await fetchSourceItems(source, state, options);
      results.push(...items.filter(item => withinLookback(item, source.lookbackHours || DEFAULT_LOOKBACK_HOURS)));
      reports.push(report);
    } catch (error) {
      const message = `${source.category}: ${source.name}: ${normalizeErrorMessage(error)}`;
      errors.push(message);
      reports.push({
        ...initSourceReport(source),
        status: 'error',
        error: normalizeErrorMessage(error)
      });
    }
  }

  results.sort((a, b) => {
    if (a.publishedAt && b.publishedAt) return new Date(b.publishedAt) - new Date(a.publishedAt);
    if (a.publishedAt) return -1;
    if (b.publishedAt) return 1;
    return 0;
  });

  return { items: results, reports };
}

function buildFeedPayload(categoryDef, items, errors, sources) {
  const categoryErrors = errors.filter(message => message.startsWith(`${categoryDef.key}:`));
  const payload = {
    generatedAt: new Date().toISOString(),
    [categoryDef.key]: items,
    stats: {
      [categoryDef.statsKey]: items.length
    },
    meta: {
      sourceCount: sources.length
    },
    errors: categoryErrors.length > 0 ? categoryErrors : undefined
  };

  if (categoryDef.key === 'departments') {
    payload.meta.availableDepartments = sources.map(source => source.departmentName || source.name);
  }

  return payload;
}

function buildCategorySummary(items, reports) {
  const okSources = reports.filter(report => report.status === 'ok').length;
  const emptySources = reports.filter(report => report.status === 'empty').length;
  const errorSources = reports.filter(report => report.status === 'error').length;
  return {
    itemCount: items.length,
    okSources,
    emptySources,
    errorSources
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const sources = await loadSources();
  const state = args.validate ? { seenItems: {} } : await loadState();
  const errors = [];
  const options = {
    useState: !args.validate,
    updateState: !args.validate
  };

  const report = {
    status: 'ok',
    mode: args.validate ? 'validate' : 'generate',
    generatedAt: new Date().toISOString(),
    categories: {}
  };

  const categoryResults = {};

  for (const categoryDef of CATEGORY_DEFS) {
    const categorySources = sources[categoryDef.key] || [];
    const { items, reports } = await fetchCategoryContent(categorySources, state, options, errors);
    categoryResults[categoryDef.key] = { items, reports, sources: categorySources };
    report.categories[categoryDef.key] = {
      ...buildCategorySummary(items, reports),
      sourceCount: categorySources.length,
      sources: reports
    };
  }

  report.summary = Object.fromEntries(
    CATEGORY_DEFS.map(categoryDef => [
      categoryDef.key,
      report.categories[categoryDef.key].itemCount
    ])
  );

  if (!args.validate) {
    for (const categoryDef of CATEGORY_DEFS) {
      const category = categoryResults[categoryDef.key];
      const payload = buildFeedPayload(categoryDef, category.items, errors, category.sources);
      await writeFile(join(SCRIPT_DIR, '..', categoryDef.file), JSON.stringify(payload, null, 2));
    }
    await saveState(state);
  }

  if (args.reportPath) {
    await writeFile(args.reportPath, JSON.stringify(report, null, 2));
  }

  if (args.validate) {
    console.log(JSON.stringify({
      status: 'ok',
      mode: 'validate',
      reportPath: args.reportPath,
      summary: report.summary,
      errorCount: errors.length
    }, null, 2));
  }
}

main().catch(error => {
  console.error(JSON.stringify({
    status: 'error',
    message: normalizeErrorMessage(error)
  }, null, 2));
  process.exit(1);
});
