#!/usr/bin/env node
import 'dotenv/config';
import crypto from 'node:crypto';
import process from 'node:process';
import { XMLParser } from 'fast-xml-parser';
import { createClient } from '@supabase/supabase-js';

const REMOTIVE_API_URL = 'https://remotive.com/api/remote-jobs';
const DEFAULT_RSS_FEEDS = ['https://remotive.com/remote-jobs/feed'];
const REMOTE_OK_RSS_URL = process.env.REMOTE_OK_RSS_URL || 'https://remoteok.com/rss';
const WWR_RSS_URL =
  process.env.WWR_RSS_URL || 'https://weworkremotely.com/categories/remote-programming-jobs.rss';
const SOURCE_REMOTIVE = 'Remotive';
const SOURCE_REMOTE_OK = 'Remote OK';
const SOURCE_WWR = 'We Work Remotely';
const USER_AGENT = 'remotive-ingest/1.0 (+https://github.com/remotive)';
const BATCH_SIZE = 500;
const RSS_PARSER_OPTIONS = {
  ignoreAttributes: false,
  attributeNamePrefix: '',
  textNodeName: 'text',
  trimValues: false,
  processEntities: true
};

function requireEnv(name) {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

function sanitizeString(value) {
  if (value === undefined || value === null) return null;
  const trimmed = String(value).trim();
  return trimmed.length ? trimmed : null;
}

function toIso(value) {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function coerceText(value) {
  if (value === undefined || value === null) return null;
  if (Array.isArray(value)) {
    return coerceText(value[0]);
  }
  if (typeof value === 'object') {
    if ('#text' in value) return coerceText(value['#text']);
    if ('text' in value) return coerceText(value.text);
  }
  return sanitizeString(value);
}

function getRssFeedUrls() {
  const raw = sanitizeString(process.env.REMOTIVE_RSS_FEEDS);
  if (!raw) return DEFAULT_RSS_FEEDS;
  return raw
    .split(',')
    .map((url) => sanitizeString(url))
    .filter(Boolean);
}

function ensureArray(value) {
  if (!value) return [];
  return Array.isArray(value) ? value : [value];
}

function getRssParser() {
  return new XMLParser(RSS_PARSER_OPTIONS);
}

function stableStringify(obj) {
  return JSON.stringify(
    Object.keys(obj)
      .sort()
      .reduce((acc, key) => {
        acc[key] = obj[key] ?? null;
        return acc;
      }, {})
  );
}

function buildContentHash(jobFields) {
  const hash = crypto.createHash('sha256');
  hash.update(stableStringify(jobFields));
  return hash.digest('hex');
}

function normalizeApiJob(job) {
  const normalized = {
    source_job_id: sanitizeString(job.id ?? job.job_id ?? job.slug ?? job.uuid),
    url: sanitizeString(job.url ?? job.job_url),
    title: sanitizeString(job.title),
    company_name: sanitizeString(job.company_name),
    company_logo_url: sanitizeString(job.company_logo ?? job.company_logo_url),
    category: sanitizeString(job.category),
    job_type: sanitizeString(job.job_type),
    publication_date: toIso(job.publication_date),
    candidate_required_location: sanitizeString(job.candidate_required_location),
    salary: sanitizeString(job.salary),
    description_html: job.description ?? job.description_html ?? null
  };

  if (!normalized.source_job_id) {
    throw new Error('Encountered Remotive job without a stable id');
  }

  const hashFields = {
    source: SOURCE_REMOTIVE,
    source_job_id: normalized.source_job_id,
    url: normalized.url,
    title: normalized.title,
    company_name: normalized.company_name,
    company_logo_url: normalized.company_logo_url,
    category: normalized.category,
    job_type: normalized.job_type,
    publication_date: normalized.publication_date,
    candidate_required_location: normalized.candidate_required_location,
    salary: normalized.salary,
    description_html: normalized.description_html
  };

  return {
    ...normalized,
    content_hash: buildContentHash(hashFields),
    raw_json: job
  };
}

function normalizeRssJob(item, feedUrl) {
  const description =
    item['content:encoded'] ?? item.content?.encoded ?? item.content ?? item.description ?? null;
  const normalized = {
    source_job_id: coerceText(item.jobId ?? item.guid ?? item.link),
    url: coerceText(item.link ?? item.guid),
    title: coerceText(item.title),
    company_name: coerceText(item.company ?? item['dc:creator']),
    company_logo_url: null,
    category: coerceText(item.category),
    job_type: coerceText(item.type),
    publication_date: toIso(coerceText(item.pubDate)),
    candidate_required_location: coerceText(item.location),
    salary: coerceText(item.salary),
    description_html: description ?? null
  };

  if (!normalized.source_job_id) {
    throw new Error('Encountered Remotive RSS job without a stable id');
  }

  normalized.description_html =
    typeof normalized.description_html === 'string'
      ? normalized.description_html
      : coerceText(normalized.description_html);

  const hashFields = {
    source: SOURCE_REMOTIVE,
    source_job_id: normalized.source_job_id,
    url: normalized.url,
    title: normalized.title,
    company_name: normalized.company_name,
    company_logo_url: normalized.company_logo_url,
    category: normalized.category,
    job_type: normalized.job_type,
    publication_date: normalized.publication_date,
    candidate_required_location: normalized.candidate_required_location,
    salary: normalized.salary,
    description_html: normalized.description_html
  };

  return {
    ...normalized,
    content_hash: buildContentHash(hashFields),
    raw_json: {
      feed_url: feedUrl,
      item
    }
  };
}

function normalizeRemoteOkJob(item) {
  const description = item.description ?? item['content:encoded'] ?? null;
  const categoryValues = [];
  if (Array.isArray(item.category)) {
    categoryValues.push(
      ...item.category
        .map((entry) => coerceText(entry))
        .filter(Boolean)
    );
  }
  const tags = coerceText(item.tags);
  if (tags) {
    categoryValues.push(tags);
  }

  const normalized = {
    source_job_id: coerceText(item.guid ?? item.id ?? item.link),
    url: coerceText(item.link),
    title: coerceText(item.title),
    company_name: coerceText(item.company),
    company_logo_url: coerceText(item.companyLogo ?? item.logo ?? item.image),
    category: categoryValues.length ? categoryValues.join(', ') : null,
    job_type: coerceText(item.type),
    publication_date: toIso(coerceText(item.pubDate)),
    candidate_required_location: coerceText(item.location),
    salary: coerceText(item.salary ?? item.compensation),
    description_html: description ?? null
  };

  if (!normalized.source_job_id) {
    throw new Error('Encountered Remote OK job without a stable id');
  }

  if (typeof normalized.description_html !== 'string') {
    normalized.description_html = coerceText(normalized.description_html);
  }

  const hashFields = {
    source: SOURCE_REMOTE_OK,
    source_job_id: normalized.source_job_id,
    url: normalized.url,
    title: normalized.title,
    company_name: normalized.company_name,
    company_logo_url: normalized.company_logo_url,
    category: normalized.category,
    job_type: normalized.job_type,
    publication_date: normalized.publication_date,
    candidate_required_location: normalized.candidate_required_location,
    salary: normalized.salary,
    description_html: normalized.description_html
  };

  return {
    ...normalized,
    content_hash: buildContentHash(hashFields),
    raw_json: {
      feed_url: REMOTE_OK_RSS_URL,
      item
    }
  };
}

function splitCompanyFromTitle(title) {
  if (!title) return { company: null, jobTitle: null };
  const [company, ...rest] = title.split(':');
  if (!rest.length) {
    return { company: null, jobTitle: title };
  }
  const companyName = company.trim() || null;
  const jobTitle = rest.join(':').trim() || title;
  return { company: companyName, jobTitle };
}

function normalizeWwrJob(item) {
  const description = item.description ?? item['content:encoded'] ?? null;
  const title = coerceText(item.title);
  const { company: parsedCompany, jobTitle } = splitCompanyFromTitle(title ?? '');
  const normalized = {
    source_job_id: coerceText(item.guid ?? item.link ?? title),
    url: coerceText(item.link),
    title: jobTitle || title,
    company_name: parsedCompany,
    company_logo_url: null,
    category: coerceText(item.category),
    job_type: null,
    publication_date: toIso(coerceText(item.pubDate)),
    candidate_required_location: coerceText(item.region),
    salary: null,
    description_html: description ?? null
  };

  if (!normalized.source_job_id) {
    throw new Error('Encountered We Work Remotely job without a stable id');
  }

  if (typeof normalized.description_html !== 'string') {
    normalized.description_html = coerceText(normalized.description_html);
  }

  const hashFields = {
    source: SOURCE_WWR,
    source_job_id: normalized.source_job_id,
    url: normalized.url,
    title: normalized.title,
    company_name: normalized.company_name,
    company_logo_url: normalized.company_logo_url,
    category: normalized.category,
    job_type: normalized.job_type,
    publication_date: normalized.publication_date,
    candidate_required_location: normalized.candidate_required_location,
    salary: normalized.salary,
    description_html: normalized.description_html
  };

  return {
    ...normalized,
    content_hash: buildContentHash(hashFields),
    raw_json: {
      feed_url: WWR_RSS_URL,
      item
    }
  };
}

async function fetchRemotiveApiJobs() {
  const response = await fetch(REMOTIVE_API_URL, {
    headers: { 'User-Agent': USER_AGENT }
  });
  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Remotive API error: ${response.status} ${response.statusText} - ${text}`);
  }
  const payload = await response.json();
  if (!payload || !Array.isArray(payload.jobs)) {
    throw new Error('Unexpected Remotive API response structure');
  }
  return payload.jobs.map(normalizeApiJob);
}

async function fetchRemotiveRssJobs(feedUrls) {
  if (!feedUrls.length) return [];
  const parser = getRssParser();

  const jobs = [];
  for (const feedUrl of feedUrls) {
    const response = await fetch(feedUrl, {
      headers: {
        'User-Agent': USER_AGENT,
        Accept: 'application/rss+xml, application/xml;q=0.9, */*;q=0.8'
      }
    });
    if (!response.ok) {
      const text = await response.text();
      throw new Error(`Remotive RSS error (${feedUrl}): ${response.status} ${response.statusText} - ${text}`);
    }
    const xml = await response.text();
    const parsed = parser.parse(xml);
    const items = extractChannelItems(parsed, feedUrl);
    for (const item of items) {
      jobs.push(normalizeRssJob(item, feedUrl));
    }
  }
  return jobs;
}

async function fetchRemoteOkJobs() {
  if (!REMOTE_OK_RSS_URL) return [];
  const parser = getRssParser();
  const response = await fetch(REMOTE_OK_RSS_URL, {
    headers: {
      'User-Agent': USER_AGENT,
      Accept: 'application/rss+xml, application/xml;q=0.9, */*;q=0.8'
    }
  });
  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Remote OK RSS error: ${response.status} ${response.statusText} - ${text}`);
  }
  const xml = await response.text();
  const parsed = parser.parse(xml);
  const items = extractChannelItems(parsed, REMOTE_OK_RSS_URL);
  return items.map((item) => normalizeRemoteOkJob(item));
}

async function fetchWwrJobs() {
  if (!WWR_RSS_URL) return [];
  const parser = getRssParser();
  const response = await fetch(WWR_RSS_URL, {
    headers: {
      'User-Agent': USER_AGENT,
      Accept: 'application/rss+xml, application/xml;q=0.9, */*;q=0.8'
    }
  });
  if (!response.ok) {
    const text = await response.text();
    throw new Error(`We Work Remotely RSS error: ${response.status} ${response.statusText} - ${text}`);
  }
  const xml = await response.text();
  const parsed = parser.parse(xml);
  const items = extractChannelItems(parsed, WWR_RSS_URL);
  return items.map((item) => normalizeWwrJob(item));
}

function extractChannelItems(parsed, feedUrl) {
  const channelNode = parsed?.rss?.channel
    ? Array.isArray(parsed.rss.channel)
      ? parsed.rss.channel[0]
      : parsed.rss.channel
    : parsed?.channel ?? null;
  if (!channelNode) {
    throw new Error(`RSS error (${feedUrl}): missing channel node`);
  }
  return ensureArray(channelNode.item);
}

function chunkJobs(jobs) {
  const batches = [];
  for (let i = 0; i < jobs.length; i += BATCH_SIZE) {
    batches.push(jobs.slice(i, i + BATCH_SIZE));
  }
  return batches;
}

async function upsertJobsForSource(supabase, source, jobs, runTsIso) {
  const batches = chunkJobs(jobs);
  let totalUpserted = 0;
  for (const batch of batches) {
    const { data, error } = await supabase.rpc('upsert_job_listings_batch', {
      p_source: source,
      p_run_ts: runTsIso,
      p_jobs: batch
    });
    if (error) {
      throw new Error(`Supabase upsert failed for ${source}: ${error.message}`);
    }
    totalUpserted += Number(data ?? 0);
  }
  return { batches: batches.length, upsertedRows: totalUpserted };
}

async function markMissingJobs(supabase, source, runTsIso) {
  const { data, error } = await supabase.rpc('mark_missing_job_listings', {
    p_source: source,
    p_run_ts: runTsIso
  });
  if (error) {
    throw new Error(`Supabase mark-missing failed for ${source}: ${error.message}`);
  }
  return Number(data ?? 0);
}

async function ingestRemotive(supabase, runTsIso, rssFeedUrls) {
  const [apiJobs, rssJobs] = await Promise.all([
    fetchRemotiveApiJobs(),
    fetchRemotiveRssJobs(rssFeedUrls)
  ]);

  const jobMap = new Map();
  for (const rssJob of rssJobs) {
    jobMap.set(rssJob.source_job_id, rssJob);
  }
  for (const apiJob of apiJobs) {
    jobMap.set(apiJob.source_job_id, apiJob);
  }

  const jobs = Array.from(jobMap.values());
  const { batches, upsertedRows } = await upsertJobsForSource(
    supabase,
    SOURCE_REMOTIVE,
    jobs,
    runTsIso
  );
  const markedMissing = await markMissingJobs(supabase, SOURCE_REMOTIVE, runTsIso);

  return {
    source: SOURCE_REMOTIVE,
    apiJobs: apiJobs.length,
    rssJobs: rssJobs.length,
    rssFeeds: rssFeedUrls.length,
    combinedJobs: jobs.length,
    batches,
    upsertedRows,
    markedMissing
  };
}

async function ingestRemoteOk(supabase, runTsIso) {
  const jobs = await fetchRemoteOkJobs();
  const { batches, upsertedRows } = await upsertJobsForSource(
    supabase,
    SOURCE_REMOTE_OK,
    jobs,
    runTsIso
  );
  const markedMissing = await markMissingJobs(supabase, SOURCE_REMOTE_OK, runTsIso);

  return {
    source: SOURCE_REMOTE_OK,
    rssJobs: jobs.length,
    rssFeeds: REMOTE_OK_RSS_URL ? 1 : 0,
    combinedJobs: jobs.length,
    batches,
    upsertedRows,
    markedMissing
  };
}

async function ingestWwr(supabase, runTsIso) {
  const jobs = await fetchWwrJobs();
  const { batches, upsertedRows } = await upsertJobsForSource(
    supabase,
    SOURCE_WWR,
    jobs,
    runTsIso
  );
  const markedMissing = await markMissingJobs(supabase, SOURCE_WWR, runTsIso);

  return {
    source: SOURCE_WWR,
    rssJobs: jobs.length,
    rssFeeds: WWR_RSS_URL ? 1 : 0,
    combinedJobs: jobs.length,
    batches,
    upsertedRows,
    markedMissing
  };
}

async function run() {
  const SUPABASE_URL = requireEnv('SUPABASE_URL');
  const SUPABASE_SERVICE_ROLE_KEY = requireEnv('SUPABASE_SERVICE_ROLE_KEY');

  const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
    auth: {
      autoRefreshToken: false,
      persistSession: false
    }
  });

  const runTsIso = new Date().toISOString();
  const rssFeedUrls = getRssFeedUrls();
  const remotiveStats = await ingestRemotive(supabase, runTsIso, rssFeedUrls);
  const remoteOkStats = await ingestRemoteOk(supabase, runTsIso);
  const wwrStats = await ingestWwr(supabase, runTsIso);

  const summary = {
    runTs: runTsIso,
    sources: {
      remotive: remotiveStats,
      remoteOk: remoteOkStats,
      weWorkRemotely: wwrStats
    },
    totalUpserted:
      remotiveStats.upsertedRows + remoteOkStats.upsertedRows + wwrStats.upsertedRows,
    totalMarkedMissing:
      remotiveStats.markedMissing + remoteOkStats.markedMissing + wwrStats.markedMissing
  };

  console.log(JSON.stringify(summary));
}

run().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
