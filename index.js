/**
 * BSD 3-Clause License
 *
 * Copyright (c) 2018-2019, Steve Tung
 * All rights reserved.
 *
 * Redistribution and use in source and binary forms, with or without
 * modification, are permitted provided that the following conditions are met:
 *
 * * Redistributions of source code must retain the above copyright notice, this
 *   list of conditions and the following disclaimer.
 *
 * * Redistributions in binary form must reproduce the above copyright notice,
 *   this list of conditions and the following disclaimer in the documentation
 *   and/or other materials provided with the distribution.
 *
 * * Neither the name of the copyright holder nor the names of its
 *   contributors may be used to endorse or promote products derived from
 *   this software without specific prior written permission.
 *
 * THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS "AS IS"
 * AND ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE
 * IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE ARE
 * DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT HOLDER OR CONTRIBUTORS BE LIABLE
 * FOR ANY DIRECT, INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR CONSEQUENTIAL
 * DAMAGES (INCLUDING, BUT NOT LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR
 * SERVICES; LOSS OF USE, DATA, OR PROFITS; OR BUSINESS INTERRUPTION) HOWEVER
 * CAUSED AND ON ANY THEORY OF LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY,
 * OR TORT (INCLUDING NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF THE USE
 * OF THIS SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.
 */

const puppeteer = require('puppeteer')
const path = require('path')
const defaultDuration = 5
const defaultFPS = 60
const { overwriteRandom } = require('./lib/overwrite-random')
const { promiseLoop, getBrowserFrames } = require('./lib/utils')
const initializePageUtils = require('./lib/page-utils')
const initializeMediaTimeHandler = require('./lib/media-time-handler')
const overwriteTime = require('./lib/overwrite-time')
const captureScreenshot = require('./lib/capture-screenshot')
const immediateCanvasHandler = require('./lib/immediate-canvas-handler')
const captureCanvas = require('./lib/capture-canvas')

module.exports = async config => {
  config = Object.assign({}, config || {})
  let url = config.url || 'index.html'
  let { frameNumToTime, fps } = config
  let framesToCapture
  const outputPath = path.resolve(process.cwd(), config.outputDirectory || './')
  const { unrandomize: unrandom } = config
  const delayMs = 1000 * (config.start || 0)
  const startWaitMs = 1000 * (config.startDelay || 0)

  if (url.indexOf('://') === -1) {
    // assume it is a file path
    url = 'file://' + path.resolve(process.cwd(), url)
  }

  if (config.frames) {
    framesToCapture = config.frames
    if (!fps) {
      if (config.duration) {
        fps = framesToCapture / config.duration
      } else {
        fps = defaultFPS
      }
    }
  } else {
    if (!fps) {
      fps = defaultFPS
    }
    if (config.duration) {
      framesToCapture = config.duration * fps
    } else {
      framesToCapture = defaultDuration * fps
    }
  }

  let frameDuration = 1000 / fps

  if (!frameNumToTime) {
    frameNumToTime = function(frameCount) {
      return (frameCount - 1) * frameDuration
    }
  }

  const log = function() {
    if (!config.quiet) {
      if (config.logToStdErr) {
        // eslint-disable-next-line no-console
        console.error.apply(this, arguments)
      } else {
        // eslint-disable-next-line no-console
        console.log.apply(this, arguments)
      }
    }
  }

  const launchOptions = {
    dumpio: !config.quiet && !config.logToStdErr,
    headless: config.headless !== undefined ? config.headless : true,
    executablePath: config.executablePath,
    args: config.launchArguments || []
  }

  const getBrowser = (config, launchOptions) => {
    if (config.browser) {
      return Promise.resolve(config.browser)
    } else if (config.launcher) {
      return Promise.resolve(config.launcher(launchOptions))
    } else if (config.remoteUrl) {
      let queryString = Object.keys(launchOptions)
        .map(key => key + '=' + launchOptions[key])
        .join('&')
      let remote = config.remoteUrl + '?' + queryString
      return puppeteer.connect({ browserWSEndpoint: remote })
    } else {
      return puppeteer.launch(launchOptions)
    }
  }

  try {
    const browser = await getBrowser(config, launchOptions)
    const page = await browser.newPage()
    // A marker is an action at a specific time
    let markers = []
    let markerId = 0
    const addMarker = ({ time, type, data }) =>
      markers.push({ time, type, data, id: markerId++ })
    config = Object.assign(
      {
        log,
        outputPath,
        page,
        addMarker,
        framesToCapture
      },
      config
    )
    let capturer, timeHandler
    if (config.canvasCaptureMode) {
      if (
        typeof config.canvasCaptureMode === 'string' &&
        config.canvasCaptureMode.startsWith('immediate')
      ) {
        // remove starts of 'immediate' or 'immediate:'
        config.canvasCaptureMode = config.canvasCaptureMode.replace(
          /^immediate:?/,
          ''
        )
        ;({ timeHandler, capturer } = immediateCanvasHandler(
          config
        ))
        log('Capture Mode: Immediate Canvas')
      } else {
        timeHandler = overwriteTime
        capturer = captureCanvas(config)
        log('Capture Mode: Canvas')
      }
    } else {
      timeHandler = overwriteTime
      capturer = captureScreenshot(config)
      log('Capture Mode: Screenshot')
    }
    if (config.viewport) {
      if (!config.viewport.width) {
        config.viewport.width = page.viewport().width
      }
      if (!config.viewport.height) {
        config.viewport.height = page.viewport().height
      }
      await page.setViewport(config.viewport)
    }
    await overwriteRandom(page, unrandom, log)
    await timeHandler.overwriteTime(page)
    await initializePageUtils(page)
    await initializeMediaTimeHandler(page)
    log('Going to ' + url + '...')
    await page.goto(url, { waitUntil: 'networkidle0' })
    log('Page loaded')
    if ('preparePage' in config) {
      log('Preparing page before screenshots...')
      await config.preparePage(page)
      log('Page prepared')
    }
    await new Promise(resolve => {
      setTimeout(resolve, startWaitMs)
    })
    if (capturer.beforeCapture) {
      await capturer.beforeCapture(config)
    }

    let browserTime = 0
    const browserFrames = getBrowserFrames(page.mainFrame())
    if (
      config.captureWhileSelectorExists &&
      !(await page.$(config.captureWhileSelectorExists))
    ) {
      while (!(await page.$(config.captureWhileSelectorExists))) {
        browserTime += frameDuration
        await timeHandler.goToTimeAndAnimate(browserFrames, browserTime)
      }
    }

    const captureTimes = []
    for (let i = 1; i <= framesToCapture; i++) {
      addMarker({
        time: delayMs + browserTime + frameNumToTime(i, framesToCapture),
        type: 'Capture',
        data: { frameCount: i }
      })
      captureTimes.push(delayMs + frameNumToTime(i, framesToCapture))
    }

    // run 'requestAnimationFrame' early on, just in case if there
    // is initialization code inside of it
    const addAnimationGapThreshold = 100
    const addAnimationFrameTime = 20
    if (captureTimes.length && captureTimes[0] > addAnimationGapThreshold) {
      addMarker({
        time: addAnimationFrameTime,
        type: 'Only Animate'
      })
    }

    let lastMarkerTime = 0
    const maximumAnimationFrameDuration = config.maximumAnimationFrameDuration
    captureTimes.forEach(time => {
      if (maximumAnimationFrameDuration) {
        let frameDuration = time - lastMarkerTime
        let framesForDuration = Math.ceil(
          frameDuration / maximumAnimationFrameDuration
        )
        for (let i = 1; i < framesForDuration; i++) {
          addMarker({
            time: lastMarkerTime + (i * frameDuration) / framesForDuration,
            type: 'Only Animate'
          })
        }
      }
      lastMarkerTime = time
    })

    markers = markers.sort((a, b) => {
      if (a.time !== b.time) {
        return a.time - b.time
      }
      return a.id - b.id
    })

    const startCaptureTime = new Date().getTime()
    for (let markerIndex = 0; markerIndex < markers.length; markerIndex++) {
      const marker = markers[markerIndex]
      if (marker.type === 'Capture') {
        await timeHandler.goToTimeAndAnimateForCapture(
          browserFrames,
          marker.time
        )
        if (
          config.captureWhileSelectorExists &&
          !(await page.$(config.captureWhileSelectorExists))
        ) {
          break
        }

        if (config.preparePageForScreenshot) {
          log('Preparing page for screenshot...')
          await config.preparePageForScreenshot(
            page,
            marker.data.frameCount,
            framesToCapture
          )
          log('Page prepared')
        }

        if (capturer.capture) {
          await capturer.capture(
            config,
            marker.data.frameCount,
            framesToCapture
          )
        }
      } else if (marker.type === 'Only Animate') {
        await timeHandler.goToTimeAndAnimate(browserFrames, marker.time)
      }
    }
    log('Elapsed capture time: ' + (new Date().getTime() - startCaptureTime))
    if (capturer.afterCapture) {
      await capturer.afterCapture()
    }

    await browser.close()
  } catch (err) {
    log(err)
  }
}
