#!/usr/bin/env node
import 'dotenv/config';
import crypto from 'node:crypto';
import process from 'node:process';
import { XMLParser } from 'fast-xml-parser';
import { createClient } from '@supabase/supabase-js';

const REMOTIVE_API_URL = 'https://remotive.com/api/remote-jobs';
const DEFAULT_RSS_FEEDS = ['https://remotive.com/remote-jobs/feed'];
const SOURCE = 'Remotive';
const USER_AGENT = 'remotive-ingest/1.0 (+https://github.com/remotive)';
const BATCH_SIZE = 500;

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
    source: SOURCE,
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
    source: SOURCE,
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
  const parser = new XMLParser({
    ignoreAttributes: false,
    attributeNamePrefix: '',
    textNodeName: 'text',
    trimValues: false
  });

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
    const channelNode = parsed?.rss?.channel
      ? Array.isArray(parsed.rss.channel)
        ? parsed.rss.channel[0]
        : parsed.rss.channel
      : null;
    if (!channelNode) {
      throw new Error(`Remotive RSS error (${feedUrl}): missing channel node`);
    }
    let items = channelNode.item ?? [];
    if (!Array.isArray(items)) {
      items = items ? [items] : [];
    }
    for (const item of items) {
      jobs.push(normalizeRssJob(item, feedUrl));
    }
  }
  return jobs;
}

function chunkJobs(jobs) {
  const batches = [];
  for (let i = 0; i < jobs.length; i += BATCH_SIZE) {
    batches.push(jobs.slice(i, i + BATCH_SIZE));
  }
  return batches;
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
  const batches = chunkJobs(jobs);

  let totalUpserted = 0;
  for (const batch of batches) {
    const { data, error } = await supabase.rpc('upsert_job_listings_batch', {
      p_source: SOURCE,
      p_run_ts: runTsIso,
      p_jobs: batch
    });
    if (error) {
      throw new Error(`Supabase upsert failed: ${error.message}`);
    }
    totalUpserted += Number(data ?? 0);
  }

  const { data: markedData, error: markError } = await supabase.rpc('mark_missing_job_listings', {
    p_source: SOURCE,
    p_run_ts: runTsIso
  });
  if (markError) {
    throw new Error(`Supabase mark-missing failed: ${markError.message}`);
  }

  const summary = {
    source: SOURCE,
    runTs: runTsIso,
    apiJobs: apiJobs.length,
    rssJobs: rssJobs.length,
    rssFeeds: rssFeedUrls.length,
    combinedJobs: jobs.length,
    batches: batches.length,
    upsertedRows: totalUpserted,
    markedMissing: Number(markedData ?? 0)
  };

  console.log(JSON.stringify(summary));
}

run().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
