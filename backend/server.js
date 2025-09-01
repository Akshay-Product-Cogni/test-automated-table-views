// Backend API for Automated Table Views (POC)
// - Exposes a single POST /api/page-data endpoint that:
//   1) Reads a hardcoded page definition
//   2) Inspects BigQuery schema to generate filter configs
//   3) Builds a WHERE clause from saved + user filters
//   4) Executes a paginated query and returns data + pagination + applied saved filter
// - Also includes utility endpoints to inspect accessible datasets/tables and verify BQ connectivity

require('dotenv').config();
const express = require('express');
const path = require('path');
const cors = require('cors');
const fs = require('fs');
const { BigQuery } = require('@google-cloud/bigquery');
const { listPages, getPageConfiguration } = require('./pageDefinitions');
const { formatTableHeaders } = require('./utils/formatTableHeaders');
const { generateFilterConfigFromSchema, generateFilterConfig } = require('./utils/generateFilterConfig');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());

// Serve static frontend (single-page app)
const frontendDir = path.join(__dirname, '..', 'frontend');
app.use(express.static(frontendDir));

// Initialize BigQuery client
// - Prefers inline JSON via GCP_KEY_JSON for local dev
// - Falls back to GOOGLE_APPLICATION_CREDENTIALS env var path
let bigquery = null;
try {
  if (process.env.GCP_KEY_JSON) {
    bigquery = new BigQuery({ credentials: JSON.parse(process.env.GCP_KEY_JSON) });
  } else {
    bigquery = new BigQuery();
  }
} catch (e) {
  // eslint-disable-next-line no-console
  console.warn('BigQuery client not initialized yet. Set GOOGLE_APPLICATION_CREDENTIALS or GCP_KEY_JSON.');
}

// Sample payload kept for reference (not used once BigQuery is integrated)
const samplePath = path.join(__dirname, '..', 'sample_response.json');
let sampleResponse = {};
try {
  sampleResponse = JSON.parse(fs.readFileSync(samplePath, 'utf-8'));
} catch (error) {
  // eslint-disable-next-line no-console
  console.error('Failed to load sample_response.json:', error);
}

// Core endpoint: returns page data + filters + pagination based on saved/user filters
app.post('/api/page-data', async (req, res) => {
  const { pageIdentifier, savedFilterIdentifier = null, userFilters = {}, pagination = { page: 1, pageSize: 10 } } = req.body || {};
  // Request log (shape only) to aid debugging
  // eslint-disable-next-line no-console
  console.log('[REQUEST] /api/page-data', {
    pageIdentifier,
    savedFilterIdentifier,
    pagination,
    userFilterKeys: Object.keys(userFilters || {})
  });

  // Resolve page configuration (dataset/table/savedFilters)
  const cfg = getPageConfiguration(pageIdentifier);
  if (!cfg) return res.status(400).json({ ok: false, error: 'Invalid pageIdentifier' });
  if (!bigquery) return res.status(500).json({ ok: false, error: 'BigQuery client not initialized' });

  try {
    // Read table schema to compute headers + filter config
    const dataset = bigquery.dataset(cfg.datasetId);
    const table = dataset.table(cfg.tableId);
    const [metadata] = await table.getMetadata();
    const fields = (metadata.schema && metadata.schema.fields) || [];
    const columnNames = fields.filter((f) => f.type !== 'RECORD').map((f) => f.name);

    // 1) Table headers: readable display names from raw column keys
    const tableHeaders = formatTableHeaders(columnNames);

    // 2) Filter config: dynamic options (distinct/top-10) + type-driven defaults
    const filterConfig = await generateFilterConfig(bigquery, bigquery.projectId, cfg.datasetId, cfg.tableId, fields);

    // 3) WHERE clause construction from saved + user filters
    const savedFilter = (cfg.savedFilters || []).find((sf) => sf.identifier === savedFilterIdentifier);
    const savedFilterDefinition = savedFilter && savedFilter.filterDefinition ? savedFilter.filterDefinition : {};

    // --- Helpers: SQL literal + shared predicates for empty/not-empty ---
    function sqlStringLiteral(value) {
      if (value == null) return 'NULL';
      return `'${String(value).replace(/'/g, "''")}'`;
    }

    function buildEmptyNotEmpty(column) {
      const ident = `\`${column}\``;
      return {
        // Consider NULL or empty-string as "Empty" consistently across types (non-date)
        empty: `(${ident} IS NULL OR CAST(${ident} AS STRING) = '')`,
        notEmpty: `(NOT (${ident} IS NULL OR CAST(${ident} AS STRING) = ''))`
      };
    }

    // Normalize modality to a lowercase string (supports array form in saved filters)
    function normalizeModality(mod) {
      if (Array.isArray(mod) && mod.length > 0) return String(mod[0]).toLowerCase();
      if (typeof mod === 'string') return mod.toLowerCase();
      return '';
    }

    // Build predicate for a saved filter definition entry
    // - Supports LIST/BOOLEAN/NUMERIC/DATE/TIMESTAMP/FREETEXT
    // - Adds explicit empty/not-empty handling for non-date types via modality
    function buildPredicateFromDef(column, def) {
      const ident = `\`${column}\``;
      const type = (def.type || '').toUpperCase();
      const modality = normalizeModality(def.modality);
      const values = Array.isArray(def.values) ? def.values : [];

      // Empty/Not Empty via modality for non-date types
      if (!['DATE', 'DATETIME', 'TIMESTAMP'].includes(type)) {
        if (['is_null', 'empty', 'is empty'].includes(modality)) {
          const en = buildEmptyNotEmpty(column);
          return en.empty;
        }
        if (['is_not_null', 'not_empty', 'is not empty'].includes(modality)) {
          const en = buildEmptyNotEmpty(column);
          return en.notEmpty;
        }
      }

      if (type === 'LIST') {
        if (!values.length) return null;
        const inList = values.map(sqlStringLiteral).join(', ');
        return `${ident} IN (${inList})`;
      }
      if (type === 'BOOLEAN' || type === 'BOOL') {
        if (!values.length) return null;
        return `${ident} = ${values[0] ? 'TRUE' : 'FALSE'}`;
      }
      if (type === 'NUMERIC') {
        const v0 = values[0];
        const v1 = values[1];
        if (modality === 'greater than') return `${ident} > ${Number(v0)}`;
        if (modality === 'less than') return `${ident} < ${Number(v0)}`;
        if (modality === 'between') return `${ident} BETWEEN ${Number(v0)} AND ${Number(v1)}`;
        return `${ident} = ${Number(v0)}`; // equals default
      }
      if (type === 'DATE' || type === 'DATETIME' || type === 'TIMESTAMP') {
        // Expect YYYY-MM-DD values for saved filters
        const v0 = values[0];
        const v1 = values[1];
        if (!v0 && !v1) return null;
        const colDate = `DATE(${ident})`;
        if (modality === 'before') return `${colDate} < DATE(${sqlStringLiteral(v0)})`;
        if (modality === 'after') return `${colDate} > DATE(${sqlStringLiteral(v0)})`;
        if (modality === 'between') return `${colDate} BETWEEN DATE(${sqlStringLiteral(v0)}) AND DATE(${sqlStringLiteral(v1)})`;
        return `${colDate} = DATE(${sqlStringLiteral(v0)})`;
      }
      // FREETEXT: contains/exact/starts with
      if (values.length) {
        let pattern = `%${String(values[0])}%`;
        if (modality === 'exact') pattern = String(values[0]);
        if (modality === 'starts with') pattern = `${String(values[0])}%`;
        const op = modality === 'exact' ? '=' : 'LIKE';
        const rhs = modality === 'exact' ? `LOWER(${sqlStringLiteral(pattern)})` : `LOWER(${sqlStringLiteral(pattern)})`;
        return `LOWER(CAST(${ident} AS STRING)) ${op} ${rhs}`;
      }
      return null;
    }

    // Build predicate for a user-applied filter (chips or popover)
    // - Mirrors saved filter behavior but also supports common relative DATE tokens
    function buildPredicateFromUser(column, userDef, fieldType) {
      const type = (userDef.type || fieldType || '').toUpperCase();
      const values = Array.isArray(userDef.values) ? userDef.values : [];
      const ident = `\`${column}\``;
      const modality = normalizeModality(userDef.modality);

      // Unified Empty/Not Empty handling when user selects a designated token
      if (values.length === 1 && (values[0] === 'Empty' || values[0] === 'Not Empty')) {
        const en = buildEmptyNotEmpty(column);
        return values[0] === 'Empty' ? en.empty : en.notEmpty;
      }
      // Empty/Not Empty via modality for non-date types
      if (!['DATE', 'DATETIME', 'TIMESTAMP'].includes(type)) {
        if (['is_null', 'empty', 'is empty'].includes(modality)) {
          const en = buildEmptyNotEmpty(column);
          return en.empty;
        }
        if (['is_not_null', 'not_empty', 'is not empty'].includes(modality)) {
          const en = buildEmptyNotEmpty(column);
          return en.notEmpty;
        }
      }

      if (type === 'LIST') {
        if (!values.length) return null;
        const inList = values.map(sqlStringLiteral).join(', ');
        return `${ident} IN (${inList})`;
      }
      if (type === 'BOOLEAN' || type === 'BOOL') {
        if (!values.length) return null;
        return `${ident} = ${values[0] ? 'TRUE' : 'FALSE'}`;
      }
      if (type === 'NUMERIC') {
        // Minimal numeric support for chips/popover single-entry
        if (!values.length) return null;
        if (typeof values[0] === 'string' && /top 10%|bottom 10%/i.test(values[0])) return null; // skip unsupported tokens
        return `${ident} = ${Number(values[0])}`;
      }
      if (type === 'DATE' || type === 'DATETIME' || type === 'TIMESTAMP') {
        // Support relative tokens for convenience
        const colDate = `DATE(${ident})`;
        const token = values[0];
        if (!token) return null;
        if (token === 'today') return `${colDate} = CURRENT_DATE()`;
        if (token === 'yesterday') return `${colDate} = DATE_SUB(CURRENT_DATE(), INTERVAL 1 DAY)`;
        if (token === 'last 7 days') return `${colDate} BETWEEN DATE_SUB(CURRENT_DATE(), INTERVAL 7 DAY) AND CURRENT_DATE()`;
        if (token === 'this month') return `${colDate} BETWEEN DATE_TRUNC(CURRENT_DATE(), MONTH) AND CURRENT_DATE()`;
        if (token === 'last month') return `${colDate} BETWEEN DATE_SUB(DATE_TRUNC(CURRENT_DATE(), MONTH), INTERVAL 1 MONTH) AND DATE_SUB(DATE_TRUNC(CURRENT_DATE(), MONTH), INTERVAL 1 DAY)`;
        if (token === 'tomorrow') return `${colDate} = DATE_ADD(CURRENT_DATE(), INTERVAL 1 DAY)`;
        if (token === 'next 7 days') return `${colDate} BETWEEN CURRENT_DATE() AND DATE_ADD(CURRENT_DATE(), INTERVAL 7 DAY)`;
        if (token === 'next month') return `${colDate} BETWEEN DATE_TRUNC(DATE_ADD(CURRENT_DATE(), INTERVAL 1 MONTH), MONTH) AND DATE_SUB(DATE_TRUNC(DATE_ADD(CURRENT_DATE(), INTERVAL 2 MONTH), MONTH), INTERVAL 1 DAY)`;
        return null;
      }
      // FREETEXT: contains/exact/starts with
      if (values.length) {
        let pattern = `%${String(values[0])}%`;
        if (modality === 'exact') pattern = String(values[0]);
        if (modality === 'starts with') pattern = `${String(values[0])}%`;
        const op = modality === 'exact' ? '=' : 'LIKE';
        const rhs = modality === 'exact' ? `LOWER(${sqlStringLiteral(pattern)})` : `LOWER(${sqlStringLiteral(pattern)})`;
        return `LOWER(CAST(${ident} AS STRING)) ${op} ${rhs}`;
      }
      return null;
    }

    // Evaluate saved + user filters against known columns only
    const whereClauses = [];
    const fieldTypeByName = new Map(fields.map((f) => [f.name, (f.type || '').toUpperCase()]));

    // Saved filter predicates
    for (const [col, def] of Object.entries(savedFilterDefinition || {})) {
      if (!fieldTypeByName.has(col)) {
        // eslint-disable-next-line no-console
        console.warn('[WARN] Saved filter references unknown column; skipping', { col });
        continue;
      }
      const pred = buildPredicateFromDef(col, def || {});
      if (pred) whereClauses.push(pred);
    }

    // User filter predicates
    for (const [col, def] of Object.entries(userFilters || {})) {
      if (!fieldTypeByName.has(col)) {
        // eslint-disable-next-line no-console
        console.warn('[WARN] User filter references unknown column; skipping', { col });
        continue;
      }
      const pred = buildPredicateFromUser(col, def || {}, fieldTypeByName.get(col));
      if (pred) whereClauses.push(pred);
    }

    // 4) Query data + count with WHERE and LIMIT/OFFSET
    const qualified = `\`${bigquery.projectId}.${cfg.datasetId}.${cfg.tableId}\``;
    const whereSql = whereClauses.length ? `WHERE ${whereClauses.join(' AND ')}` : '';

    const limit = Math.max(1, Math.min(1000, pagination.pageSize || 10));
    const offset = Math.max(0, ((pagination.page || 1) - 1) * limit);
    const query = `SELECT * FROM ${qualified} ${whereSql} LIMIT ${limit} OFFSET ${offset}`;
    // eslint-disable-next-line no-console
    console.log('[QUERY] data', query);

    const [rows] = await bigquery.query({ query });

    // Count for pagination (could be optimized e.g., cached or approximated)
    let totalRecords = 0;
    try {
      const countQuery = `SELECT COUNT(1) AS c FROM ${qualified} ${whereSql}`;
      // eslint-disable-next-line no-console
      console.log('[QUERY] count', countQuery);
      const [countRows] = await bigquery.query({ query: countQuery });
      totalRecords = Number(countRows[0].c) || 0;
    } catch (e) {
      totalRecords = rows.length;
    }

    const totalPages = Math.max(1, Math.ceil(totalRecords / limit));

    // Response includes appliedSavedFilter for frontend to render saved chips
    const responsePayload = {
      pageDetails: { title: cfg.title, subtitle: cfg.subtitle },
      tableHeaders,
      data: rows,
      filterConfig,
      savedFilters: (cfg.savedFilters || []).map(({ identifier, displayName }) => ({ identifier, displayName })),
      pagination: {
        currentPage: pagination.page || 1,
        pageSize: limit,
        totalRecords,
        totalPages
      },
      appliedSavedFilter: savedFilter
        ? { identifier: savedFilter.identifier, displayName: savedFilter.displayName, filterDefinition: savedFilter.filterDefinition || {} }
        : null
    };

    return res.json(responsePayload);
  } catch (error) {
    // Log full error for diagnosis in dev
    // eslint-disable-next-line no-console
    console.error('[ERROR] /api/page-data failed', error);
    return res.status(500).json({ ok: false, error: String(error) });
  }
});

// Simple pages listing for UI to populate page selector
app.get('/api/pages', (req, res) => {
  res.json({ ok: true, pages: listPages() });
});

// Return a single page definition (debug aid)
app.get('/api/pages/:id', (req, res) => {
  const cfg = getPageConfiguration(req.params.id);
  if (!cfg) return res.status(404).json({ ok: false, error: 'Page not found' });
  return res.json({ ok: true, page: cfg });
});

// Health check: run a trivial query to verify BigQuery connectivity
app.get('/api/health/bigquery', async (req, res) => {
  if (!bigquery) {
    return res.status(500).json({ ok: false, error: 'BigQuery client not initialized' });
  }
  try {
    const [rows] = await bigquery.query({ query: 'SELECT 1 AS ok' });
    return res.json({ ok: true, result: rows[0] });
  } catch (error) {
    return res.status(500).json({ ok: false, error: String(error) });
  }
});

// Explorer endpoints to list datasets and tables (useful for setup and debugging)
app.get('/api/bq/datasets', async (req, res) => {
  if (!bigquery) {
    return res.status(500).json({ ok: false, error: 'BigQuery client not initialized' });
  }
  try {
    const [datasets] = await bigquery.getDatasets();
    const items = datasets.map((d) => ({ id: d.id })).sort((a, b) => a.id.localeCompare(b.id));
    return res.json({ ok: true, datasets: items });
  } catch (error) {
    return res.status(500).json({ ok: false, error: String(error) });
  }
});

app.get('/api/bq/tables', async (req, res) => {
  if (!bigquery) {
    return res.status(500).json({ ok: false, error: 'BigQuery client not initialized' });
  }
  const datasetId = req.query.dataset;
  const projectId = req.query.project;
  const tableId = req.query.table;
  if (!datasetId) {
    return res.status(400).json({ ok: false, error: 'Missing required query param: dataset' });
  }
  try {
    const dataset = projectId ? bigquery.dataset(datasetId, { projectId }) : bigquery.dataset(datasetId);

    if (tableId) {
      // Return table schema flattened for nested RECORD fields
      const table = dataset.table(tableId);
      const [metadata] = await table.getMetadata();
      const fields = (metadata.schema && metadata.schema.fields) || [];

      const flattenFields = (arr, prefix = '') => {
        const out = [];
        for (const f of arr) {
          const name = prefix ? `${prefix}.${f.name}` : f.name;
          if (f.type === 'RECORD' && Array.isArray(f.fields) && f.fields.length > 0) {
            out.push({ name, type: f.type, mode: f.mode || 'NULLABLE', description: f.description || '' });
            out.push(...flattenFields(f.fields, name));
          } else {
            out.push({ name, type: f.type, mode: f.mode || 'NULLABLE', description: f.description || '' });
          }
        }
        return out;
      };

      const schema = flattenFields(fields);
      return res.json({
        ok: true,
        project: projectId || bigquery.projectId,
        dataset: datasetId,
        table: tableId,
        schema
      });
    }

    // Otherwise list tables for dataset
    const [tables] = await dataset.getTables();
    const items = tables.map((t) => ({ id: t.id })).sort((a, b) => a.id.localeCompare(b.id));
    return res.json({ ok: true, dataset: datasetId, project: projectId || bigquery.projectId, tables: items });
  } catch (error) {
    return res.status(500).json({ ok: false, error: String(error) });
  }
});

// SPA fallback
app.get('*', (req, res) => {
  res.sendFile(path.join(frontendDir, 'index.html'));
});

app.listen(PORT, () => {
  // eslint-disable-next-line no-console
  console.log(`Server listening on http://localhost:${PORT}`);
});


