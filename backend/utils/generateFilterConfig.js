function generateFilterConfigFromSchema(schemaFields) {
  const config = [];
  for (const f of schemaFields) {
    // Skip RECORD for quick POC (could be expanded)
    if (f.type === 'RECORD') continue;
    const columnName = f.name;
    let filterType = 'FREETEXT';
    let options = [];

    const type = (f.type || '').toUpperCase();
    if (type === 'DATE' || type === 'DATETIME' || type === 'TIMESTAMP') {
      filterType = 'DATE';
      options = ['today', 'yesterday', 'last 7 days', 'this month', 'last month'];
    } else if (type === 'BOOL' || type === 'BOOLEAN') {
      filterType = 'BOOLEAN';
      options = [true, false];
    } else if (['INT64', 'NUMERIC', 'BIGNUMERIC', 'FLOAT64'].includes(type)) {
      filterType = 'NUMERIC';
      options = ['top 10%', 'bottom 10%'];
    } else if (type === 'STRING') {
      filterType = 'FREETEXT';
      options = [];
    }

    if (options.length === 0) {
      options = ['Empty', 'Not Empty'];
    }

    config.push({ columnName, filterType, options });
  }
  return config;
}

async function generateFilterConfig(bigquery, projectId, datasetId, tableId, schemaFields) {
  const qualified = `\`${projectId}.${datasetId}.${tableId}\``;
  const config = [];

  for (const f of schemaFields) {
    if (f.type === 'RECORD') continue;
    const columnName = f.name;
    const type = (f.type || '').toUpperCase();
    let filterType = 'FREETEXT';
    let options = [];

    try {
      if (type === 'DATE' || type === 'DATETIME' || type === 'TIMESTAMP') {
        filterType = 'DATE';
        options = ['today', 'yesterday', 'last 7 days', 'this month', 'last month', 'tomorrow', 'next 7 days', 'next month'];
      } else if (type === 'BOOL' || type === 'BOOLEAN') {
        filterType = 'BOOLEAN';
        options = [true, false];
      } else if (['INT64', 'NUMERIC', 'BIGNUMERIC', 'FLOAT64'].includes(type)) {
        filterType = 'NUMERIC';
        options = ['top 10%', 'bottom 10%'];
      } else if (type === 'STRING') {
        // Decide LIST vs FREETEXT using approx distinct count
        const countQuery = `SELECT APPROX_COUNT_DISTINCT(\`${columnName}\`) AS c FROM ${qualified}`;
        const [countRows] = await bigquery.query({ query: countQuery });
        const distinctCount = Number(countRows[0].c) || 0;
        if (distinctCount <= 20) {
          filterType = 'LIST';
          const listQuery = `SELECT DISTINCT CAST(\`${columnName}\` AS STRING) AS v FROM ${qualified} WHERE \`${columnName}\` IS NOT NULL ORDER BY v LIMIT 20`;
          const [vals] = await bigquery.query({ query: listQuery });
          options = vals.map((r) => r.v);
        } else {
          filterType = 'FREETEXT';
          const topQuery = `SELECT CAST(\`${columnName}\` AS STRING) AS v, COUNT(1) AS c FROM ${qualified} WHERE \`${columnName}\` IS NOT NULL GROUP BY v ORDER BY c DESC LIMIT 10`;
          const [vals] = await bigquery.query({ query: topQuery });
          options = vals.map((r) => r.v);
        }
      } else {
        filterType = 'FREETEXT';
      }
    } catch (e) {
      // Fallback if any query fails
      filterType = type === 'BOOLEAN' ? 'BOOLEAN' : filterType;
      options = options;
    }

    if (!options || options.length === 0) {
      options = ['Empty', 'Not Empty'];
    }

    config.push({ columnName, filterType, options });
  }

  return config;
}

module.exports = { generateFilterConfigFromSchema, generateFilterConfig };


