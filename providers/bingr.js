// Bingr Provider for Nuvio / Lentra
// Streams from https://bingr.one (embed: https://bingr.one/watch/movie/{tmdbId})
// Resolved through the official api.bingr.one endpoints used by the site's own player:
//   POST {API}/stream            body: { srv, t, id, query }
//   GET  {API}/stream/aphelion-tv/{id}/{season}/{episode}  (Aphelion TV special case)
// Response: { scraperName, sources: [{ url, quality, language, type, label, headers }], subtitles }
// Sources are direct MP4 links (proxied) and/or HLS (m3u8) — both playable in ExoPlayer.

var API_BASE = 'https://api.bingr.one/api'
var SITE = 'https://bingr.one'
var UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36'
var SERVER_TIMEOUT = 15000
var DETAILS_TIMEOUT = 10000
var MAX_STREAMS = 12

// Active servers on bingr.one — priority order matches the site's own cascade
// (kept in sync with the frontend server list; ids may rotate, unknown ids just 404 harmlessly)
var SERVERS = [
  { id: 's40', name: 'Aphelion' },
  { id: 's70', name: 'Polaris' },
  { id: 's62', name: 'Bastion' },
  { id: 's63', name: 'Hallyu' },
  { id: 's30', name: 'Nova' },
  { id: 's60', name: 'Vertex' },
  { id: 's61', name: 'Corvus' },
  { id: 's31', name: 'Orion' },
  { id: 's3', name: 'Edmunds' }
]

function baseHeaders() {
  return {
    'User-Agent': UA,
    'Origin': SITE,
    'Referer': SITE + '/'
  }
}

function fetchWithTimeout(url, options, timeout) {
  options = options || {}
  return new Promise(function (resolve, reject) {
    var controller = typeof AbortController !== 'undefined' ? new AbortController() : null
    var timer = null
    if (controller) {
      timer = setTimeout(function () {
        try { controller.abort() } catch (e) { /* noop */ }
      }, timeout)
      options.signal = controller.signal
    }
    fetch(url, options)
      .then(function (res) {
        if (timer) clearTimeout(timer)
        if (!res.ok) throw new Error('HTTP ' + res.status)
        resolve(res)
      })
      .catch(function (err) {
        if (timer) clearTimeout(timer)
        reject(err)
      })
  })
}

// Title + year from bingr's own details endpoint (no TMDB key needed).
// Non-fatal: the stream API also resolves by id alone.
function fetchDetails(tmdbId, mediaType) {
  var url = API_BASE + '/details/' + mediaType + '/' + tmdbId
  return fetchWithTimeout(url, { headers: baseHeaders() }, DETAILS_TIMEOUT)
    .then(function (r) { return r.json() })
    .then(function (data) {
      if (!data) return { title: null, year: null }
      var title = data.title || data.name || null
      var year = data.year
      if (!year) {
        var date = data.release_date || data.first_air_date || ''
        year = date ? String(date).slice(0, 4) : null
      }
      return { title: title, year: year ? String(year) : null }
    })
    .catch(function (err) {
      console.log('[Bingr] details fetch failed (continuing without title): ' + err.message)
      return { title: null, year: null }
    })
}

// Ask one server for the stream list. Returns { server, data } or null.
function requestServer(server, tmdbId, mediaType, season, episode, title, year) {
  var id = String(tmdbId)
  var query = {}
  if (title) query.title = title
  if (year) query.year = String(year)
  if (mediaType === 'tv' && season != null && episode != null) {
    query.season = Number(season)
    query.episode = Number(episode)
  }

  var request
  if (server.id === 's40' && mediaType === 'tv' && season != null && episode != null) {
    // Aphelion has a dedicated GET endpoint for TV episodes
    request = fetchWithTimeout(
      API_BASE + '/stream/aphelion-tv/' + id + '/' + season + '/' + episode,
      { headers: baseHeaders() },
      SERVER_TIMEOUT
    )
  } else {
    request = fetchWithTimeout(
      API_BASE + '/stream',
      {
        method: 'POST',
        headers: Object.assign({ 'Content-Type': 'application/json' }, baseHeaders()),
        body: JSON.stringify({ srv: server.id, t: mediaType, id: id, query: query })
      },
      SERVER_TIMEOUT
    )
  }

  return request
    .then(function (r) { return r.json() })
    .then(function (data) {
      if (!data || !data.sources || data.sources.length === 0) {
        console.log('[Bingr] ' + server.name + ': no sources')
        return null
      }
      console.log('[Bingr] ' + server.name + ': ' + data.sources.length + ' source(s) (' + (data.scraperName || '?') + ')')
      return { server: server, data: data }
    })
    .catch(function (err) {
      console.log('[Bingr] ' + server.name + ' failed: ' + err.message)
      return null
    })
}

function qualityLabel(q) {
  var s = q ? String(q).trim() : ''
  return s || 'Auto'
}

function qualityRank(q) {
  if (!q) return 0
  var s = String(q).toLowerCase()
  if (s === '4k' || s.indexOf('2160') >= 0) return 100
  if (s.indexOf('1080') >= 0) return 90
  if (s.indexOf('720') >= 0) return 80
  if (s.indexOf('540') >= 0) return 70
  if (s.indexOf('480') >= 0) return 60
  if (s.indexOf('360') >= 0) return 50
  var m = s.match(/(\d+)p/)
  if (m) return parseInt(m[1], 10) / 2
  if (s === 'auto') return 40
  return 30
}

function buildHeaders(srcHeaders) {
  var headers = {
    'User-Agent': UA,
    'Referer': SITE + '/'
  }
  if (srcHeaders && typeof srcHeaders === 'object') {
    for (var k in srcHeaders) {
      if (Object.prototype.hasOwnProperty.call(srcHeaders, k)) headers[k] = srcHeaders[k]
    }
  }
  return headers
}

function getStreams(tmdbId, mediaType, season, episode) {
  if (!tmdbId) return Promise.resolve([])
  mediaType = mediaType === 'tv' ? 'tv' : 'movie'

  console.log('[Bingr] Resolving ' + mediaType + ' ' + tmdbId +
    (mediaType === 'tv' ? ' S' + season + 'E' + episode : ''))

  return fetchDetails(tmdbId, mediaType)
    .then(function (meta) {
      var jobs = SERVERS.map(function (server) {
        return requestServer(server, tmdbId, mediaType, season, episode, meta.title, meta.year)
      })
      return Promise.all(jobs)
    })
    .then(function (results) {
      var streams = []
      var seen = {}

      results.forEach(function (res) {
        if (!res) return
        var server = res.server
        var priority = SERVERS.indexOf(server)
        var sorted = res.data.sources.slice().sort(function (a, b) {
          return qualityRank(b.quality) - qualityRank(a.quality)
        })
        sorted.forEach(function (src) {
          if (!src || !src.url || seen[src.url]) return
          seen[src.url] = true

          var q = qualityLabel(src.quality)
          var lang = src.language && src.language !== 'Original' ? ' • ' + src.language : ''
          streams.push({
            name: 'Bingr',
            title: server.name + ' • ' + q + lang,
            url: src.url,
            quality: q,
            priority: priority * 1000 - qualityRank(src.quality),
            headers: buildHeaders(src.headers)
          })
        })
      })

      // Highest quality first, then server priority
      streams.sort(function (a, b) { return a.priority - b.priority })

      var out = streams.slice(0, MAX_STREAMS)
      console.log('[Bingr] Returning ' + out.length + ' stream(s)')
      return out
    })
    .catch(function (err) {
      console.error('[Bingr] Error: ' + err.message)
      return []
    })
}

module.exports = { getStreams }
