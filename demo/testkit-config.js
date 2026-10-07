// Shared study config for every page of the demo prototype.
TestKit.init({
  study: 'grid-filters-v2',
  activate: 'query', // add ?test=1 to the URL to show the overlay
  audio: { enabled: true, bitrate: 32000 },
  mask: { inputs: true },
  tasks: [
    { id: 'filter', prompt: 'Filter the list to healthcare companies', successHint: 'Sector filter set to Healthcare', timeLimit: 90 },
    { id: 'detail', prompt: 'Open the company profile for Meridian Health', successHint: 'Company page for Meridian Health is open' },
    {
      id: 'export',
      prompt: 'Go back to the list and export the current view',
      timeLimit: 60,
      followUp: 'Was anything about exporting unclear?',
    },
  ],
});
