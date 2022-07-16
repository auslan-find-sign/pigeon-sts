# pigeon-sts
Spread the Sign spider, which captures one language from the site, and exports search-data json compatible with Auslan Find Sign search engine.

This is a command line tool, which does a full scrape in one go. It's recommended that you provide a cache directory, as a command line option. This folder will store about 600mb of html files. The advantage to a cache is you can tweak the code and rebuild the output without having to download it all from SpreadTheSign again.

This is the implementation currently used by Auslan Find Sign for it's SpreadTheSign search index.
