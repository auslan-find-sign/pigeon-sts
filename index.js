import yargs from 'yargs'
import { hideBin } from 'yargs/helpers'
import fs from 'fs-extra'
import path from 'path'
import { decode } from 'pigeonmark-html'
import { selectAll, selectOne } from 'pigeonmark-select'
import pm from 'pigeonmark-utils'
import fetch from 'cross-fetch'
import './array-at-polyfill.js'
import parseDuration from 'parse-duration'
import PQueue from 'p-queue'
import { pipeline } from 'stream/promises'

const { argv } = yargs(hideBin(process.argv))
  .option('url', {
    type: 'string',
    default: 'https://www.spreadthesign.com',
    description: 'base url to SpreadTheSign service'
  })
  .option('language', {
    alias: 'l',
    type: 'string',
    description: 'Language to spider',
    default: 'en.au'
  })
  .option('data', {
    alias: 'd',
    type: 'string',
    description: 'Path to store data',
    default: './spread-the-sign-auslan.json'
  })
  .option('cache-folder', {
    alias: 'c',
    type: 'string',
    description: 'If provided, this folder is used to store a cache of html documents'
  })
  .option('cache-duration', {
    type: 'string',
    description: 'How old to cached pages remain valid, e.g. "1wk"',
    default: '1wk'
  })
  .option('concurrency', {
    type: 'number',
    default: 10,
    description: 'How many parallel requests are allowed?'
  })

async function readSite (url) {
  if (argv.cacheFolder) {
    const cacheFilename = path.join(argv.cacheFolder, `${encodeURIComponent(url)}.html`)
    if (await fs.pathExists(cacheFilename)) {
      if ((await fs.stat(cacheFilename)).mtimeMs > Date.now() - parseDuration(argv.cacheDuration)) {
        return decode(await fs.readFile(cacheFilename))
      }
    }
  }
  const response = await fetch(`${url}`)
  if (response.ok) {
    const text = await response.text()
    if (argv.cacheFolder) {
      await fs.ensureDir(argv.cacheFolder)
      const cacheFilename = path.join(argv.cacheFolder, `${encodeURIComponent(url)}.html`)
      await fs.writeFile(cacheFilename, text)
    }
    return decode(text)
  }
}

function rel (left, right) {
  return (new URL(left, right)).toString()
}

function tagify (str) {
  return str.replace(/[^a-zA-Z_-]+/gmi, '.').toLowerCase().replace(/\.+/gmi, '.').replace(/_+/gmi, '_').replace(/-+/gmi, '-')
}

async function scrapePage ({ searchData, entryURL, categories, category }) {
  console.log(`Reading ${entryURL}`)
  const page = await readSite(entryURL)
  const id = entryURL.split('/').find(x => x.match(/^[0-9]+$/))
  const canonicalLink = rel(pm.get.attribute(selectOne(page, 'link[rel=canonical]'), 'href'), entryURL)
  const title = pm.get.text(selectOne(page, '.search-result-content h2')).trim()
  const kind = pm.get.text(selectOne(page, '.search-result.open small')).trim()
  const body = pm.get.attribute(selectOne(page, 'meta[name=description]'), 'content')
  const media = selectAll(page, 'video').map(x => (
    { method: 'fetch', url: pm.get.attribute(x, 'src') }
  ))

  if (media.length > 0) {
    const existing = searchData[id] || { tags: [] }

    searchData[id] = {
      title,
      link: canonicalLink,
      nav: [
        ['SpreadTheSign', argv.url],
        [category, categories[category]],
        [title, canonicalLink]
      ],
      tags: [...new Set([...['spread-the-sign', kind, category].map(tagify), ...existing.tags])],
      body,
      media,
      provider: {
        id: 'spread-the-sign',
        link: argv.url,
        verb: 'documented'
      }
    }

    console.log(searchData[id])
  }
}

async function run () {
  const searchData = {}

  const baseURL = `${argv.url}/${encodeURIComponent(argv.language)}/`

  // get category list
  console.log('loading categories list...')
  const categoriesURL = `${baseURL}search/by-category/`
  const categoriesPage = await readSite(categoriesURL)
  if (!categoriesPage) throw new Error('Couldn\'t load categories search page')

  // make an object with link text labels as keys and link urls as values
  const categories = Object.fromEntries(selectAll(categoriesPage, '#categories li a').map(link => {
    return [pm.get.text(link), rel(pm.get.attribute(link, 'href'), categoriesURL)]
  }))

  console.log('Categories: ', Object.keys(categories).join(', '))

  const categoryEntryURLs = {}

  const categoryQueue = new PQueue({ concurrency: argv.concurrency })

  const scrapeCategory = async ({ pageURL, entryURLs }) => {
    console.log(`Scanning ${pageURL}`)
    const page = await readSite(pageURL)
    const nextPageLink = selectOne(page, '.search-pager-next a')
    const resultLinks = selectAll(page, '.search-result-title a')
    for (const resultLink of resultLinks) {
      const resultURL = rel(pm.get.attribute(resultLink, 'href'), pageURL)
      if (!entryURLs.includes(resultURL)) {
        entryURLs.push(resultURL)
      }
    }

    // continue through next pages...
    if (nextPageLink) {
      categoryQueue.add(() =>
        scrapeCategory({ entryURLs, pageURL: rel(pm.get.attribute(nextPageLink, 'href'), pageURL) })
      )
    }
  }

  for (const category in categories) {
    console.log(`Looking at Category: ${category}...`)

    const entryURLs = categoryEntryURLs[category] = []
    let pageURL = categories[category]

    categoryQueue.add(() => scrapeCategory({ pageURL, entryURLs }))
  }

  await categoryQueue.onEmpty()

  const pageQueue = new PQueue({ concurrency: argv.concurrency })
  for (const category in categoryEntryURLs) {
    const categoryEntries = categoryEntryURLs[category]
    for (const entryURL of categoryEntries) {
      pageQueue.add(() => scrapePage({ searchData, entryURL, categories, category }))
    }
  }

  await pageQueue.onEmpty()

  await fs.writeJson(argv.data, searchData)
}

run()
