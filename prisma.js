import fetch from "node-fetch"
import yts from "yt-search"
import axios from "axios"
import crypto from "crypto"

function colorize(text, isError = false) {
    const codes = {
        reset: '\x1b[0m',
        bright: '\x1b[1m',
        fg: {
            custom_cyan: '\x1b[36m', 
            red: '\x1b[31m', 
            white: '\x1b[37m',
        }
    }

    let prefix = ''
    let colorCode = codes.fg.custom_cyan

    if (text.startsWith('[BUSCANDO]')) {
        prefix = '[BUSCANDO]'
    } else if (text.startsWith('[ENVIADO]')) {
        prefix = '[ENVIADO]'
    } else if (isError || text.startsWith('[ERROR]')) {
        prefix = '[ERROR]'
        colorCode = codes.fg.red
    } else {
        return `${codes.fg.white}${text}${codes.reset}`
    }

    const body = text.substring(prefix.length).trim() 
    
    return `${colorCode}${codes.bright}${prefix}${codes.fg.white}${codes.reset} ${body}`
}

const CONFIG = {
    CACHE_DURATION: 300000,
    MAX_DURATION: 18000,
    MAX_RETRIES: 3,
    REQUEST_TIMEOUT: 2500,
    MAX_FILENAME_LENGTH: 50,
    FAST_TIMEOUT: 85,
    VIDEO_TIMEOUT: 2000,
    AUDIO_FALLBACK_TIMEOUT: 550,
    FALLBACK_RACE_TIMEOUT: 1500
}

const cache = new Map()

setInterval(() => {
    const now = Date.now()
    for (const [key, value] of cache.entries()) {
        if (now - value.timestamp > CONFIG.CACHE_DURATION) {
            cache.delete(key)
        }
    }
}, 3600000)

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms))
}

function cleanFileName(n) {
    return n.replace(/[<>:"/\\|?*]/g, "").substring(0, CONFIG.MAX_FILENAME_LENGTH)
}

function formatViews(v) {
    if (!v) return "No disponible"
    const num = typeof v === 'string' ? parseInt(v.replace(/,/g, ''), 10) : v
    if (isNaN(num)) return "No disponible"
    if (num >= 1e9) return (num / 1e9).toFixed(1) + "B"
    if (num >= 1e6) return (num / 1e6).toFixed(1) + "M"
    if (num >= 1e3) return (num / 1e3).toFixed(1) + "K"
    return num.toString()
}

const savetube = {
    api: {
        base: 'https://media.savetube.me/api',
        info: '/v2/info',
        download: '/download',
        cdn: '/random-cdn',
    },
    headers: {
        accept: '*/*',
        'content-type': 'application/json',
        origin: 'https://yt.savetube.me',
        referer: 'https://yt.savetube.me/',
        'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    },
    crypto: {
        hexToBuffer: (hexString) => Buffer.from(hexString.match(/.{1,2}/g).join(''), 'hex'),
        decrypt: async (enc) => {
            const secretKey = 'C5D58EF67A7584E4A29F6C35BBC4EB12'
            const data = Buffer.from(enc, 'base64')
            const iv = data.slice(0, 16)
            const content = data.slice(16)
            const key = savetube.crypto.hexToBuffer(secretKey)
            const decipher = crypto.createDecipheriv('aes-128-cbc', key, iv)
            const decrypted = Buffer.concat([decipher.update(content), decipher.final()])
            try {
                return JSON.parse(decrypted.toString())
            } catch {
                return { title: 'Desconocido', duration: '??', key: null }
            }
        },
    },
    isUrl: (str) => {
        try {
            new URL(str)
            return /youtube.com|youtu.be/.test(str)
        } catch {
            return false
        }
    },
    youtube: (url) => {
        const patterns = [
            /youtube\.com\/watch\?v=([a-zA-Z0-9_-]{11})/,
            /youtube\.com\/embed\/([a-zA-Z0-9_-]{11})/,
            /youtu\.be\/([a-zA-Z0-9_-]{11})/,
            /youtube\.com\/shorts\/([a-zA-Z0-9_-]{11})/,
            /youtube\.com\/live\/([a-zA-Z0-9_-]{11})/,
        ]
        for (let p of patterns) {
            if (p.test(url)) return url.match(p)[1]
        }
        return null
    },
    request: async (endpoint, data = {}, method = 'post') => {
        try {
            const { data: res } = await axios({
                method,
                url: `${endpoint.startsWith('http') ? '' : savetube.api.base}${endpoint}`,
                data: method === 'post' ? data : undefined,
                params: method === 'get' ? data : undefined,
                headers: savetube.headers,
                timeout: CONFIG.REQUEST_TIMEOUT,
            })
            return { status: true, data: res }
        } catch (err) {
            return { status: false, error: err.message }
        }
    },
    getCDN: async () => {
        const cacheKey = 'savetube_cdn'
        const cached = cache.get(cacheKey)
        
        if (cached && Date.now() - cached.timestamp < 300000) {
            return { status: true, data: cached.data }
        }
        
        const r = await savetube.request(savetube.api.cdn, {}, 'get')
        if (!r.status) return r
        
        cache.set(cacheKey, { data: r.data.cdn, timestamp: Date.now() })
        
        return { status: true, data: r.data.cdn }
    },
    download: async (link, type = 'audio', quality = '360') => { 
        if (!savetube.isUrl(link)) return { status: false, error: 'URL inválida' }
        
        const id = savetube.youtube(link)
        if (!id) return { status: false, error: 'No se pudo obtener ID del video' }
        
        try {
            const cdnx = await savetube.getCDN()
            if (!cdnx.status) throw new Error('No se pudo obtener CDN')
            
            const cdn = cdnx.data
            
            const info = await savetube.request(`https://${cdn}${savetube.api.info}`, {
                url: `https://www.youtube.com/watch?v=${id}`,
            })
            
            if (!info.status || !info.data?.data) {
                throw new Error('No se pudo obtener info del video')
            }
            
            const decrypted = await savetube.crypto.decrypt(info.data.data)
            
            if (!decrypted.key) {
                throw new Error('No se pudo desencriptar la clave del video')
            }
            
            const downloadData = await savetube.request(`https://${cdn}${savetube.api.download}`, {
                id,
                downloadType: type === 'audio' ? 'audio' : 'video',
                quality: type === 'audio' ? '128' : quality,
                key: decrypted.key,
            })
            
            const url = downloadData.data?.data?.downloadUrl
            if (!url) throw new Error('No se pudo generar enlace de descarga')
            
            return {
                status: true,
                result: {
                    title: decrypted.title || 'Desconocido',
                    download: url,
                    duration: decrypted.duration || '??',
                },
            }
        } catch (err) {
            return { status: false, error: err.message }
        }
    },
}

async function processDownloadWithRetry_savetube(isAudio, url, retryCount = 0, videoQuality = '360') {
    const type = isAudio ? 'audio' : 'video'
    
    let result = await savetube.download(url, type, videoQuality) 
    
    if (!result.status && !isAudio && videoQuality !== '240') {
        result = await savetube.download(url, type, '240')
    }

    if (!result.status && retryCount < CONFIG.MAX_RETRIES) {
        await sleep(1500)
        const nextQuality = !result.status && !isAudio && videoQuality !== '240' ? '240' : videoQuality
        return processDownloadWithRetry_savetube(isAudio, url, retryCount + 1, nextQuality) 
    }
    
    return result
}

class YTDown {
    constructor() {
        this.ref = 'https://ytdown.to/es2/'
        this.ct = 'application/x-www-form-urlencoded; charset=UTF-8'
        this.origin = 'https://ytdown.to'
        this.staticUA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
    }

    generarIP() {
        return `${Math.floor(Math.random() * 256)}.${Math.floor(Math.random() * 256)}.${Math.floor(Math.random() * 256)}.${Math.floor(Math.random() * 256)}`
    }

    async req(url, dat, acc = '*/*') {
        try {
            const headers = {
                'Accept': acc,
                'Content-Type': this.ct,
                'Origin': this.origin,
                'Referer': this.ref,
                'User-Agent': this.staticUA,
                'X-Forwarded-For': this.generarIP(),
                'X-Requested-With': 'XMLHttpRequest'
            }

            const res = await axios({
                method: 'POST',
                url: url,
                headers: headers,
                data: dat,
                decompress: true,
                timeout: 30000
            })
            return res.data
        } catch (err) {
            if (err.response) {
                throw new Error(`HTTP ${err.response.status}: ${err.response.statusText}`)
            } else if (err.request) {
                throw new Error('No response from server')
            } else {
                throw new Error(`Request error: ${err.message}`)
            }
        }
    }

    async chk() {
        const res = await this.req(
            'https://ytdown.to/cooldown.php',
            'action=check',
            'application/json, text/javascript, */*; q=0.01'
        )
        return res.can_download === true
    }

    async getInfo(url) {
        const enc = encodeURIComponent(url)
        return await this.req(
            'https://ytdown.to/proxy.php',
            `url=${enc}`,
            '*/*'
        )
    }

    async rec() {
        const res = await this.req(
            'https://ytdown.to/cooldown.php',
            'action=record',
            'application/json, text/javascript, */*; q=0.01'
        )
        return res.success === true
    }

    async startDL(dlUrl) {
        const enc = encodeURIComponent(dlUrl)
        return await this.req(
            'https://ytdown.to/proxy.php',
            `url=${enc}`,
            '*/*'
        )
    }

    async waitForDL(dlUrl, timeout = 60000, interval = 2000) {
        const start = Date.now()
        while (Date.now() - start < timeout) {
            const res = await this.startDL(dlUrl)
            if (res.api && res.api.fileUrl) return res.api.fileUrl
            await new Promise(r => setTimeout(r, interval))
        }
        return dlUrl
    }

    getMed(info, fmt, quality) {
        if (!info.api || !info.api.mediaItems) return []
        const fup = fmt.toUpperCase()
        
        if (fup === 'MP3') {
            return info.api.mediaItems
                .filter(it => it.type === 'Audio')
                .map(aud => ({
                    t: aud.type,
                    n: aud.name,
                    id: aud.mediaId,
                    url: aud.mediaUrl,
                    thumb: aud.mediaThumbnail,
                    q: aud.mediaQuality,
                    dur: aud.mediaDuration,
                    ext: aud.mediaExtension,
                    sz: aud.mediaFileSize
                }))
        } else if (fup === 'MP4') {
            const exactMatch = info.api.mediaItems.find(it => it.type === 'Video' && it.mediaRes?.includes(quality))
            
            if (exactMatch) {
                return [exactMatch].map(vid => ({
                    t: vid.type,
                    n: vid.name,
                    id: vid.mediaId,
                    url: vid.mediaUrl,
                    thumb: vid.mediaThumbnail,
                    res: vid.mediaRes,
                    q: vid.mediaQuality,
                    dur: vid.mediaDuration,
                    ext: vid.mediaExtension,
                    sz: vid.mediaFileSize
                }))
            }
            
            return info.api.mediaItems
                .filter(it => it.type === 'Video')
                .map(vid => ({
                    t: vid.type,
                    n: vid.name,
                    id: vid.mediaId,
                    url: vid.mediaUrl,
                    thumb: vid.mediaThumbnail,
                    res: vid.mediaRes,
                    q: vid.mediaQuality,
                    dur: vid.mediaDuration,
                    ext: vid.mediaExtension,
                    sz: vid.mediaFileSize
                }))
        }
        return info.api.mediaItems
    }

    getBest(med, fmt, targetQuality = '1080') {
        if (!med || med.length === 0) return null
        const fup = fmt.toUpperCase()

        if (fup === 'MP3') {
            return med
                .filter(it => it.q)
                .sort((a, b) => (parseInt(b.q) || 0) - (parseInt(a.q) || 0))[0] || med[0]
        } else if (fup === 'MP4') {
            if (med.length === 1 && med[0].res?.includes(targetQuality)) return med[0]
            
            return med
                .filter(it => it.res)
                .sort((a, b) => {
                    const resA = parseInt(a.res.split('x')[0]) || 0
                    const resB = parseInt(b.res.split('x')[0]) || 0
                    
                    const target = parseInt(targetQuality)
                    
                    if (resA === target) return -1
                    if (resB === target) return 1
                    
                    if (resA > target && resB > target) return resA - resB
                    if (resA < target && resB < target) return resB - resA
                    
                    if (resA > target) return 1
                    if (resB > target) return -1
                    
                    return resB - resA
                })[0] || med[0]
        }
        return med[0]
    }

    async ytdownV2(ytUrl, fmt = 'MP3', quality = '360') {
        try {
            if (!(await this.chk())) {
                throw new Error("Service not available")
            }

            const info = await this.getInfo(ytUrl)
            if (info.api?.status === 'ERROR') {
                throw new Error(`Service error: ${info.api.message}`)
            }

            const med = this.getMed(info, fmt, quality)
            if (med.length === 0) {
                throw new Error(`No ${fmt.toUpperCase()} options available`)
            }

            const best = this.getBest(med, fmt, quality)
            if (!best) {
                throw new Error("No suitable media found")
            }

            await this.rec()

            const directUrl = await this.waitForDL(best.url, CONFIG.FALLBACK_RACE_TIMEOUT) 
            return directUrl

        } catch (err) {
            throw new Error(err.message)
        }
    }
}

const ytdownV2 = async (ytUrl, fmt = 'MP3', quality = '360') => {
    const yt = new YTDown()
    return await yt.ytdownV2(ytUrl, fmt, quality)
}

const videoQualities = ['144', '240', '360', '720', '1080', '1440', '4k']
const audioQualities = ['mp3', 'm4a', 'webm', 'aacc', 'flac', 'apus', 'ogg', 'wav']

async function processDownload_y2down(videoUrl, mediaType, quality = null) {
    const apiKey = 'dfcb6d76f2f6a9894gjkege8a4ab232222'
    const isAudio = audioQualities.includes(mediaType)
    const format = isAudio ? mediaType : quality

    const initUrl = `https://p.savenow.to/ajax/download.php?copyright=0&format=${format}&url=${encodeURIComponent(videoUrl)}&api=${apiKey}`
    
    const headers = {
        'User-Agent': 'Mozilla/5.0 (Android 13; Mobile; rv:146.0) Gecko/146.0 Firefox/146.0',
        'Referer': 'https://y2down.cc/enSB/'
    }

    try {
        const response = await fetch(initUrl, { headers })
        const data = await response.json()
        
        if (!data.success) {
            throw new Error('Init failed')
        }

        const taskId = data.id
        const progressUrl = `https://p.savenow.to/api/progress?id=${taskId}`
        
        let progress = 0
        let downloadUrl = null

        const MAX_PROGRESS_CHECKS = 10
        let checks = 0
        while (progress < 1000 && checks < MAX_PROGRESS_CHECKS) {
            await new Promise(resolve => setTimeout(resolve, 3000)) 
            
            const progressResponse = await fetch(progressUrl, { headers })
            const progressData = await progressResponse.json()
            
            progress = progressData.progress
            checks++
            
            if (progress === 1000 && progressData.download_url) {
                downloadUrl = progressData.download_url
                break
            }
        }

        if (downloadUrl) {
            return downloadUrl
        } else {
            throw new Error('No download URL')
        }

    } catch (error) {
        throw error
    }
}

async function yt2dow_cc(videoUrl, options = {}) {
    const { quality = '360', format = 'mp3', type = 'video' } = options 
    
    if (type === 'video') {
        if (!videoQualities.includes(quality)) {
            if (quality !== '1080') throw new Error(`Invalid quality: ${quality}`)
        }
        return processDownload_y2down(videoUrl, 'video', quality)
    } else {
        if (!audioQualities.includes(format)) {
            throw new Error(`Invalid format: ${format}`)
        }
        return processDownload_y2down(videoUrl, format)
    }
}

async function descargarAudioYouTube(urlVideo) {
  try {
    const data = {
      url: urlVideo,
      downloadMode: "audio",
      brandName: "ytmp3.gg",
      audioFormat: "mp3",
      audioBitrate: "128"
    }

    const headers = {
      'Accept': 'application/json',
      'Content-Type': 'application/json'
    }

    const response = await axios.post('https://hub.y2mp3.co/', data, { headers })

    const { url: downloadUrl, filename } = response.data

    if (!downloadUrl) throw new Error("No se obtuvo URL de descarga")

    return {
      success: true,
      filename,
      downloadUrl
    }
  } catch (error) {
    throw new Error(`Ytmp3.gg/y2mp3.co falló: ${error.message}`)
  }
}

const TARGET_VIDEO_QUALITY = '1080' 

async function savetube_wrapper(url, isAudio, originalTitle) {
    const videoQuality = TARGET_VIDEO_QUALITY
    const result = await processDownloadWithRetry_savetube(isAudio, url, 0, videoQuality)
    if (!result?.status || !result?.result?.download) {
        throw new Error(`Savetube falló: ${result.error || 'Error desconocido'}`)
    }
    return {
        download: result.result.download,
        title: result.result.title || originalTitle,
        winner: 'Savetube'
    }
}

async function ytdownV2_wrapper(url, isAudio, originalTitle) {
    const fmt = isAudio ? 'MP3' : 'MP4'
    const quality = TARGET_VIDEO_QUALITY
    const downloadUrl = await ytdownV2(url, fmt, quality)
    return {
        download: downloadUrl,
        title: originalTitle,
        winner: 'Ytdown.to'
    }
}

async function yt2dow_cc_wrapper(url, isAudio, originalTitle) {
    const options = isAudio 
        ? { type: 'audio', format: 'mp3' }
        : { type: 'video', quality: TARGET_VIDEO_QUALITY }
        
    const downloadUrl = await yt2dow_cc(url, options)
    return {
        download: downloadUrl,
        title: originalTitle,
        winner: 'Yt2dow.cc'
    }
}

async function ytdown_gg_wrapper(url, originalTitle) {
    const result = await descargarAudioYouTube(url)
    if (!result?.success || !result?.downloadUrl) {
        throw new Error(`Ytmp3.gg falló: ${result.error || 'Error desconocido'}`)
    }
    return {
        download: result.downloadUrl,
        title: originalTitle,
        winner: 'Ytmp3.gg'
    }
}

function timeoutPromise(promise, ms, name) {
    return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
            reject(new Error(`TIMEOUT: ${name} no respondió en ${ms/1000}s.`))
        }, ms)

        promise.then(
            (value) => {
                clearTimeout(timer)
                resolve(value)
            },
            (reason) => {
                clearTimeout(timer)
                reject(reason)
            }
        )
    })
}

async function raceWithFallback(url, isAudio, originalTitle) {
    const raceTimeout = isAudio ? CONFIG.FAST_TIMEOUT : CONFIG.VIDEO_TIMEOUT
    const fallbackTimeout = isAudio ? CONFIG.AUDIO_FALLBACK_TIMEOUT : CONFIG.FALLBACK_RACE_TIMEOUT

    const executeRace = async (ms, name_suffix = '') => {
        const promises = [
            timeoutPromise(savetube_wrapper(url, isAudio, originalTitle), ms, `Savetube${name_suffix}`).catch(e => {
                return { error: e.message, service: 'Savetube' }
            }),
            timeoutPromise(ytdownV2_wrapper(url, isAudio, originalTitle), ms, `Ytdown.to${name_suffix}`).catch(e => {
                return { error: e.message, service: 'Ytdown.to' }
            }),
            timeoutPromise(yt2dow_cc_wrapper(url, isAudio, originalTitle), ms, `Yt2dow.cc${name_suffix}`).catch(e => {
                return { error: e.message, service: 'Yt2dow.cc' }
            }),
        ]
        
        if (isAudio) {
            promises.push(timeoutPromise(ytdown_gg_wrapper(url, originalTitle), ms, `Ytmp3.gg${name_suffix}`).catch(e => {
                return { error: e.message, service: 'Ytmp3.gg' }
            }))
        }

        try {
            const winner = await Promise.race(promises)
            if (winner && winner.download) {
                return winner
            }
        } catch (e) {
            return { error: e.message }
        }
        
        const results = await Promise.all(promises.map(p => p.catch(() => null)).filter(p => p !== null))
        return results.find(r => r && r.download)
    }

    let mediaResult = await executeRace(raceTimeout, ' [RÁPIDA]')
    
    if (mediaResult?.download) {
        return mediaResult
    }
    
    if (isAudio) {
        mediaResult = await executeRace(fallbackTimeout, ' [FALLBACK]')
        
        if (mediaResult?.download) {
            return mediaResult
        }
    }
    
    if (isAudio || (!isAudio && !mediaResult?.download)) {
        mediaResult = await executeRace(CONFIG.FALLBACK_RACE_TIMEOUT, ' [FINAL]')
    }

    if (!mediaResult?.download) {
        console.error(colorize(`[ERROR] Fallo total: No se pudo obtener el archivo después de todos los reintentos.`, true))
        return null
    }

    return mediaResult
}

async function getBufferFromUrl(url) {
    const res = await fetch(url)
    if (!res.ok) throw new Error(`Error al descargar el archivo: ${res.statusText} (${res.status})`)
    return res.buffer()
}

export { raceWithFallback, cleanFileName, getBufferFromUrl, colorize }
