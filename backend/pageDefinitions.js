/**
 * Hardcoded page definitions for Phase 1 (POC)
 * Replace datasetId/tableId with your actual BigQuery dataset and table/view names.
 */

const pageDefinitions = {
  leads_view: {
    pageIdentifier: 'leads_view',
    title: 'All Leads',
    subtitle: 'A comprehensive list of all leads in the system',
    datasetId: 'relata_schema',
    tableId: 'activity',
    savedFilters: [
      {
        identifier: 'high_priority_leads',
        displayName: 'High Priority',
        filterDefinition: {
          name: { type: 'FREETEXT', modality: "Contains", values: ['ak'] },
        //   email: { type: 'FREETEXT', modality: ['is_null'], values: [] }
        }
      }
    ]
  },
  sales_report: {
    pageIdentifier: 'sales_report',
    title: 'Sales Report',
    subtitle: 'Weekly sales performance metrics',
    datasetId: 'relata_schema',
    tableId: 'vsg',
    savedFilters: [
      {
        identifier: 'top_performers',
        displayName: 'Top Performers',
        filterDefinition: {
            version: { type: 'FREETEXT', values: ['PUBLISHED'] },
            owner_project_id: { type: 'FREETEXT', modality: ['is not empty'] } //TODO: should work but diesnt as SQL parser doesnt handle NOT EMPTY
        }
      }
    ]
  }
};

function getPageConfiguration(pageIdentifier) {
  return pageDefinitions[pageIdentifier] || null;
}

function listPages() {
  return Object.values(pageDefinitions).map((p) => ({
    pageIdentifier: p.pageIdentifier,
    title: p.title,
    subtitle: p.subtitle
  }));
}

module.exports = { pageDefinitions, getPageConfiguration, listPages };


