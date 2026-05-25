import { Buffer } from 'node:buffer'

// biome-ignore lint/suspicious/noExplicitAny: internal DOM state uses unknown shapes
type AnyObj = Record<string, any>

let _ready = false

// These are populated by _init() and referenced by NativeDOM constructor.
let EMPTY_ARRAY: readonly never[]
// biome-ignore lint/suspicious/noExplicitAny: constructor cache holds arbitrary constructor functions
let dynamicClassCache: Map<string, any>
// biome-ignore lint/suspicious/noExplicitAny: event ctor protos hold arbitrary prototype shapes
let EVENT_CTOR_PROTOS: Map<string, any>
let EVENT_TYPE_MAP: Record<string, string>
let EVENT_TYPE_KEYS: string[]
let ELEMENT_STRING_PROPS: Set<string>
let ELEMENT_BOOL_PROPS: Set<string>
let ELEMENT_ZERO_PROPS: Set<string>
let SHADOW_ROOT_PROTO: AnyObj
let ANIMATION_OBJ: AnyObj
let CANVAS_2D_CTX: AnyObj
let DEFERRED_REQUEST_OBJ: AnyObj

// Class references — set by _init()
// biome-ignore lint/suspicious/noExplicitAny: DOM class stubs are untyped by design
let _classes: Record<string, any> = {}

function _init() {
  if (_ready) return
  _ready = true

  EMPTY_ARRAY = Object.freeze([]) as never[]

  dynamicClassCache = new Map()

  function getDummyConstructor(name: string) {
    const cached = dynamicClassCache.get(name)
    if (cached !== undefined) return cached

    const dummy = () => {}
    Object.defineProperty(dummy, 'name', { value: name })
    Object.defineProperty(dummy, 'toString', {
      value: () => `function ${name}() { [native code] }`
    })
    const proto = Object.create(null)
    Object.defineProperty(proto, 'constructor', {
      value: dummy,
      writable: true,
      configurable: true
    })
    Object.defineProperty(proto, Symbol.toStringTag, {
      value: name,
      configurable: true
    })
    Object.defineProperty(dummy, 'prototype', {
      value: proto,
      writable: true,
      configurable: true
    })
    dynamicClassCache.set(name, dummy)
    return dummy
  }

  class EventTarget {}
  Object.assign(EventTarget.prototype, {
    addEventListener() {},
    removeEventListener() {},
    dispatchEvent() {
      return true
    }
  })

  const NODE_CONSTANTS = Object.freeze({
    ELEMENT_NODE: 1,
    ATTRIBUTE_NODE: 2,
    TEXT_NODE: 3,
    CDATA_SECTION_NODE: 4,
    ENTITY_REFERENCE_NODE: 5,
    ENTITY_NODE: 6,
    PROCESSING_INSTRUCTION_NODE: 7,
    COMMENT_NODE: 8,
    DOCUMENT_NODE: 9,
    DOCUMENT_TYPE_NODE: 10,
    DOCUMENT_FRAGMENT_NODE: 11,
    NOTATION_NODE: 12,
    DOCUMENT_POSITION_DISCONNECTED: 1,
    DOCUMENT_POSITION_PRECEDING: 2,
    DOCUMENT_POSITION_FOLLOWING: 4,
    DOCUMENT_POSITION_CONTAINS: 8,
    DOCUMENT_POSITION_CONTAINED_BY: 16,
    DOCUMENT_POSITION_IMPLEMENTATION_SPECIFIC: 32
  })

  class Node extends EventTarget {}
  Object.assign(Node, NODE_CONSTANTS)
  Object.assign(Node.prototype, NODE_CONSTANTS)

  class Element extends Node {}
  class HTMLElement extends Element {
    get [Symbol.toStringTag]() {
      return 'HTMLElement'
    }
  }
  class HTMLIFrameElement extends HTMLElement {
    override get [Symbol.toStringTag]() {
      return 'HTMLIFrameElement'
    }
  }
  class HTMLCanvasElement extends HTMLElement {
    override get [Symbol.toStringTag]() {
      return 'HTMLCanvasElement'
    }
  }
  class HTMLImageElement extends HTMLElement {
    override get [Symbol.toStringTag]() {
      return 'HTMLImageElement'
    }
  }
  class HTMLDivElement extends HTMLElement {
    override get [Symbol.toStringTag]() {
      return 'HTMLDivElement'
    }
  }
  class HTMLBodyElement extends HTMLElement {
    override get [Symbol.toStringTag]() {
      return 'HTMLBodyElement'
    }
  }
  class HTMLHtmlElement extends HTMLElement {
    override get [Symbol.toStringTag]() {
      return 'HTMLHtmlElement'
    }
  }
  class Window extends EventTarget {
    get [Symbol.toStringTag]() {
      return 'Window'
    }
  }
  class Document extends EventTarget {
    get [Symbol.toStringTag]() {
      return 'HTMLDocument'
    }
  }
  class HTMLDocument extends Document {}
  class Navigator {
    get [Symbol.toStringTag]() {
      return 'Navigator'
    }
  }
  class Location {
    get [Symbol.toStringTag]() {
      return 'Location'
    }
  }
  class Performance {
    get [Symbol.toStringTag]() {
      return 'Performance'
    }
  }
  class Screen {
    get [Symbol.toStringTag]() {
      return 'Screen'
    }
  }
  class CSSStyleDeclaration {
    getPropertyValue() {
      return ''
    }
    setProperty() {}
    removeProperty() {
      return ''
    }
    item() {
      return ''
    }
    get [Symbol.toStringTag]() {
      return 'CSSStyleDeclaration'
    }
  }
  class PluginArray {
    get length() {
      return 0
    }
    item() {
      return null
    }
    namedItem() {
      return null
    }
    get [Symbol.toStringTag]() {
      return 'PluginArray'
    }
  }
  class MimeTypeArray {
    get length() {
      return 0
    }
    item() {
      return null
    }
    namedItem() {
      return null
    }
    get [Symbol.toStringTag]() {
      return 'MimeTypeArray'
    }
  }
  class Scheduler {
    postTask(
      // biome-ignore lint/suspicious/noExplicitAny: BotGuard passes arbitrary callbacks
      callback: any,
      // biome-ignore lint/suspicious/noExplicitAny: BotGuard options are untyped
      options?: any
    ) {
      const delay = options?.delay || 0
      return new Promise((resolve, reject) => {
        const t = setTimeout(async () => {
          try {
            resolve(await callback())
          } catch (err) {
            reject(err)
          }
        }, delay)
        if (options?.signal) {
          options.signal.addEventListener('abort', () => {
            clearTimeout(t)
            // biome-ignore lint/suspicious/noExplicitAny: globalThis DOM extension
            const g = globalThis as any
            const AbortError = g.DOMException
              ? new g.DOMException('The user aborted a request.', 'AbortError')
              : new Error('The user aborted a request.')
            reject(AbortError)
          })
        }
      })
    }
    get [Symbol.toStringTag]() {
      return 'Scheduler'
    }
  }

  SHADOW_ROOT_PROTO = (() => {
    const ShadowRoot = getDummyConstructor('ShadowRoot')
    const p = Object.create(ShadowRoot.prototype)
    Object.assign(p, {
      nodeType: 11,
      nodeName: '#document-fragment',
      innerHTML: '',
      querySelector() {
        return null
      },
      querySelectorAll() {
        return EMPTY_ARRAY
      },
      get childNodes() {
        return EMPTY_ARRAY
      },
      hasChildNodes() {
        return false
      },
      appendChild(child: unknown) {
        return child
      },
      removeChild(child: unknown) {
        return child
      }
    })
    return p
  })()

  ANIMATION_OBJ = Object.freeze({
    cancel() {},
    finish() {},
    play() {},
    pause() {}
  })

  CANVAS_2D_CTX = Object.freeze({
    fillRect() {},
    clearRect() {},
    getImageData() {
      return { data: new Uint8ClampedArray(4) }
    },
    putImageData() {},
    measureText() {
      return { width: 0 }
    },
    createLinearGradient() {
      return { addColorStop() {} }
    }
  })

  const DeferredRequest = getDummyConstructor('DeferredRequest')
  DEFERRED_REQUEST_OBJ = Object.freeze(
    Object.assign(Object.create(DeferredRequest.prototype), { activated: true })
  )

  ELEMENT_STRING_PROPS = new Set([
    'name',
    'id',
    'className',
    'title',
    'lang',
    'dir',
    'width',
    'height',
    'autocapitalize',
    'elementTiming',
    'border',
    'align',
    'virtualKeyboardPolicy',
    'longDesc',
    'srcset',
    'enterKeyHint',
    'accessKey',
    'innerHTML'
  ])

  ELEMENT_BOOL_PROPS = new Set([
    'disabled',
    'hidden',
    'checked',
    'isMap',
    'sharedStorageWritable',
    'inert'
  ])

  ELEMENT_ZERO_PROPS = new Set([
    'scrollTop',
    'scrollLeft',
    'scrollHeight',
    'scrollWidth',
    'clientTop',
    'clientLeft',
    'offsetWidth',
    'offsetHeight',
    'clientWidth',
    'clientHeight',
    'offsetTop',
    'offsetLeft',
    'hspace'
  ])

  EVENT_CTOR_PROTOS = new Map()

  EVENT_TYPE_MAP = {
    Mouse: 'MouseEvent',
    Keyboard: 'KeyboardEvent',
    Touch: 'TouchEvent',
    UI: 'UIEvent',
    Custom: 'CustomEvent',
    Mutation: 'MutationEvent',
    Message: 'MessageEvent'
  }
  EVENT_TYPE_KEYS = Object.keys(EVENT_TYPE_MAP)

  function getEventCtorProto(constructorName: string): AnyObj {
    const cached = EVENT_CTOR_PROTOS.get(constructorName)
    if (cached !== undefined) return cached

    const dummyCtor = getDummyConstructor(constructorName)
    const proto: AnyObj = Object.create(dummyCtor.prototype)
    proto.bubbles = false
    proto.cancelable = false
    proto.eventPhase = 0
    proto.defaultPrevented = false
    proto.composed = false
    proto.isTrusted = true
    proto.target = null
    proto.currentTarget = null
    proto.srcElement = null
    proto.returnValue = true
    proto.cancelBubble = false
    proto.screenX = 0
    proto.screenY = 0
    proto.clientX = 0
    proto.clientY = 0
    proto.ctrlKey = false
    proto.shiftKey = false
    proto.altKey = false
    proto.metaKey = false
    proto.button = 0
    proto.buttons = 0
    proto.which = 0
    proto.pageX = 0
    proto.pageY = 0
    proto.detail = 0
    proto.initEvent = function (
      type: string,
      bubbles: boolean,
      cancelable: boolean
    ) {
      this.type = type
      this.bubbles = bubbles
      this.cancelable = cancelable
    }
    proto.initMouseEvent = function (
      type: string,
      bubbles: boolean,
      cancelable: boolean,
      _view: unknown,
      detail: number,
      screenX: number,
      screenY: number,
      clientX: number,
      clientY: number,
      ctrlKey: boolean,
      altKey: boolean,
      shiftKey: boolean,
      metaKey: boolean,
      button: number,
      _relatedTarget: unknown
    ) {
      this.type = type
      this.bubbles = bubbles
      this.cancelable = cancelable
      this.detail = detail
      this.screenX = screenX
      this.screenY = screenY
      this.clientX = clientX
      this.clientY = clientY
      this.ctrlKey = ctrlKey
      this.altKey = altKey
      this.shiftKey = shiftKey
      this.metaKey = metaKey
      this.button = button
    }
    proto.initUIEvent = function (
      type: string,
      bubbles: boolean,
      cancelable: boolean,
      _view: unknown,
      detail: number
    ) {
      this.type = type
      this.bubbles = bubbles
      this.cancelable = cancelable
      this.detail = detail
    }
    proto.stopPropagation = () => {}
    proto.preventDefault = () => {}
    proto.stopImmediatePropagation = () => {}

    EVENT_CTOR_PROTOS.set(constructorName, proto)
    return proto
  }

  Object.defineProperties(Node.prototype, {
    ownerDocument: {
      get() {
        // biome-ignore lint/suspicious/noExplicitAny: globalThis DOM extension
        return (globalThis as any).document
      },
      configurable: true,
      enumerable: true
    },
    childNodes: {
      get() {
        return EMPTY_ARRAY
      },
      configurable: true,
      enumerable: true
    },
    nodeValue: { value: null, writable: true, configurable: true },
    textContent: { value: '', writable: true, configurable: true },
    parentNode: { value: null, writable: true, configurable: true },
    hasChildNodes: {
      value() {
        return false
      },
      writable: true,
      configurable: true
    },
    compareDocumentPosition: {
      value() {
        return 0
      },
      writable: true,
      configurable: true
    },
    appendChild: {
      value(child: unknown) {
        return child
      },
      writable: true,
      configurable: true
    },
    removeChild: {
      value(child: unknown) {
        return child
      },
      writable: true,
      configurable: true
    },
    insertBefore: {
      value(newChild: unknown) {
        return newChild
      },
      writable: true,
      configurable: true
    },
    replaceChild: {
      value(_newChild: unknown, oldChild: unknown) {
        return oldChild
      },
      writable: true,
      configurable: true
    },
    cloneNode: {
      value() {
        const tag = (this.tagName || '').toLowerCase() || 'div'
        // biome-ignore lint/suspicious/noExplicitAny: globalThis DOM extension
        return (globalThis as any).document.createElement(tag)
      },
      writable: true,
      configurable: true
    },
    addEventListener: { value() {}, writable: true, configurable: true },
    removeEventListener: { value() {}, writable: true, configurable: true },
    dispatchEvent: {
      value() {
        return true
      },
      writable: true,
      configurable: true
    },
    moveBefore: {
      value(node: unknown) {
        return node
      },
      writable: true,
      configurable: true
    },
    lookupPrefix: {
      value() {
        return null
      },
      writable: true,
      configurable: true
    },
    lookupNamespaceURI: {
      value() {
        return null
      },
      writable: true,
      configurable: true
    },
    isDefaultNamespace: {
      value() {
        return false
      },
      writable: true,
      configurable: true
    }
  })

  Object.defineProperties(Element.prototype, {
    nodeType: { value: 1, writable: true, configurable: true },
    localName: {
      get() {
        return (this.tagName || '').toLowerCase()
      },
      configurable: true,
      enumerable: true
    },
    namespaceURI: {
      get() {
        return 'http://www.w3.org/1999/xhtml'
      },
      configurable: true,
      enumerable: true
    },
    prefix: { value: null, writable: true, configurable: true },
    hasAttribute: {
      value() {
        return false
      },
      writable: true,
      configurable: true
    },
    getAttribute: {
      value() {
        return null
      },
      writable: true,
      configurable: true
    },
    setAttribute: { value() {}, writable: true, configurable: true },
    removeAttribute: { value() {}, writable: true, configurable: true },
    hasAttributeNS: {
      value() {
        return false
      },
      writable: true,
      configurable: true
    },
    getAttributeNS: {
      value() {
        return null
      },
      writable: true,
      configurable: true
    },
    setAttributeNS: { value() {}, writable: true, configurable: true },
    removeAttributeNS: { value() {}, writable: true, configurable: true },
    releasePointerCapture: { value() {}, writable: true, configurable: true },
    setPointerCapture: { value() {}, writable: true, configurable: true },
    hasPointerCapture: {
      value() {
        return false
      },
      writable: true,
      configurable: true
    },
    getAttributeNode: {
      value() {
        return null
      },
      writable: true,
      configurable: true
    },
    getAttributeNodeNS: {
      value() {
        return null
      },
      writable: true,
      configurable: true
    },
    getElementsByTagName: {
      value() {
        return EMPTY_ARRAY
      },
      writable: true,
      configurable: true
    },
    getElementsByTagNameNS: {
      value() {
        return EMPTY_ARRAY
      },
      writable: true,
      configurable: true
    },
    querySelector: {
      value() {
        return null
      },
      writable: true,
      configurable: true
    },
    querySelectorAll: {
      value() {
        return EMPTY_ARRAY
      },
      writable: true,
      configurable: true
    },
    scrollTop: { value: 0, writable: true, configurable: true },
    scrollLeft: { value: 0, writable: true, configurable: true },
    scrollHeight: { value: 0, writable: true, configurable: true },
    scrollWidth: { value: 0, writable: true, configurable: true },
    clientTop: { value: 0, writable: true, configurable: true },
    clientLeft: { value: 0, writable: true, configurable: true },
    firstElementChild: { value: null, writable: true, configurable: true },
    lastElementChild: { value: null, writable: true, configurable: true },
    nextElementSibling: { value: null, writable: true, configurable: true },
    previousElementSibling: { value: null, writable: true, configurable: true },
    children: {
      get() {
        return EMPTY_ARRAY
      },
      configurable: true,
      enumerable: true
    },
    prepend: { value() {}, writable: true, configurable: true },
    append: { value() {}, writable: true, configurable: true },
    replaceWith: { value() {}, writable: true, configurable: true },
    hasAttributes: {
      value() {
        return false
      },
      writable: true,
      configurable: true
    },
    scrollIntoViewIfNeeded: { value() {}, writable: true, configurable: true },
    removeAttributeNode: { value() {}, writable: true, configurable: true },
    setAttributeNode: { value() {}, writable: true, configurable: true },
    normalize: { value() {}, writable: true, configurable: true },
    dispatchEvent: {
      value() {
        return true
      },
      writable: true,
      configurable: true
    },
    animate: {
      value() {
        return ANIMATION_OBJ
      },
      writable: true,
      configurable: true
    },
    browsingTopics: {
      async value() {
        return EMPTY_ARRAY
      },
      writable: true,
      configurable: true
    },
    ariaNotify: { value() {}, writable: true, configurable: true },
    checkVisibility: {
      value() {
        return true
      },
      writable: true,
      configurable: true
    },
    webkitMatchesSelector: {
      value() {
        return false
      },
      writable: true,
      configurable: true
    },
    attachShadow: {
      value(init?: { mode?: string }) {
        const shadowRoot: AnyObj = Object.create(SHADOW_ROOT_PROTO)
        shadowRoot.mode = init?.mode || 'open'
        shadowRoot.host = this
        return shadowRoot
      },
      writable: true,
      configurable: true
    }
  })

  Object.defineProperties(HTMLElement.prototype, {
    dir: { value: '', writable: true, configurable: true },
    id: { value: '', writable: true, configurable: true },
    className: { value: '', writable: true, configurable: true },
    title: { value: '', writable: true, configurable: true },
    lang: { value: '', writable: true, configurable: true },
    offsetHeight: { value: 0, writable: true, configurable: true },
    offsetWidth: { value: 0, writable: true, configurable: true },
    clientHeight: { value: 0, writable: true, configurable: true },
    clientWidth: { value: 0, writable: true, configurable: true },
    click: { value() {}, writable: true, configurable: true },
    blur: { value() {}, writable: true, configurable: true },
    focus: { value() {}, writable: true, configurable: true }
  })

  // ts was so annonying to test and make holy. its not perfect, but it works :p

  Object.defineProperties(Document.prototype, {
    defaultCharset: { value: 'UTF-8', writable: true, configurable: true },
    readyState: { value: 'complete', writable: true, configurable: true },
    hidden: { value: false, writable: true, configurable: true },
    hasFocus: {
      value() {
        return true
      },
      writable: true,
      configurable: true
    },
    getElementsByTagNameNS: {
      value() {
        return EMPTY_ARRAY
      },
      writable: true,
      configurable: true
    },
    getElementById: {
      value() {
        return null
      },
      writable: true,
      configurable: true
    },
    querySelector: {
      value() {
        return null
      },
      writable: true,
      configurable: true
    },
    querySelectorAll: {
      value() {
        return EMPTY_ARRAY
      },
      writable: true,
      configurable: true
    },
    createTextNode: {
      value(text: string) {
        return { nodeValue: text, textContent: text }
      },
      writable: true,
      configurable: true
    },
    createDocumentFragment: {
      value() {
        const frag: AnyObj = Object.create(Node.prototype)
        frag.nodeType = 11
        return frag
      },
      writable: true,
      configurable: true
    }
  })

  Object.assign(HTMLIFrameElement.prototype, {
    width: '',
    height: '',
    contentDocument: null,
    contentWindow: null
  })
  Object.assign(HTMLCanvasElement.prototype, { width: 300, height: 150 })
  Object.assign(HTMLImageElement.prototype, {
    width: 0,
    height: 0,
    src: '',
    alt: '',
    useMap: '',
    complete: true,
    hspace: 0,
    vspace: 0
  })

  _classes = {
    EventTarget,
    Node,
    Element,
    HTMLElement,
    HTMLIFrameElement,
    HTMLCanvasElement,
    HTMLImageElement,
    HTMLDivElement,
    HTMLBodyElement,
    HTMLHtmlElement,
    Window,
    Document,
    HTMLDocument,
    Navigator,
    Location,
    Performance,
    Screen,
    CSSStyleDeclaration,
    PluginArray,
    MimeTypeArray,
    Scheduler,
    getDummyConstructor,
    getEventCtorProto
  }
}

function isConstructorName(prop: string): boolean {
  const c0 = prop.charCodeAt(0)
  if (c0 >= 65 && c0 <= 90) return true
  if (
    c0 === 119 &&
    prop.length > 6 &&
    prop.charCodeAt(1) === 101 &&
    prop.charCodeAt(2) === 98 &&
    prop.charCodeAt(3) === 107 &&
    prop.charCodeAt(4) === 105 &&
    prop.charCodeAt(5) === 116
  ) {
    const c6 = prop.charCodeAt(6)
    return c6 >= 65 && c6 <= 90
  }
  if (
    c0 === 109 &&
    prop.length > 3 &&
    prop.charCodeAt(1) === 111 &&
    prop.charCodeAt(2) === 122
  ) {
    const c3 = prop.charCodeAt(3)
    return c3 >= 65 && c3 <= 90
  }
  if (c0 === 109 && prop.length > 2 && prop.charCodeAt(1) === 115) {
    const c2 = prop.charCodeAt(2)
    return c2 >= 65 && c2 <= 90
  }
  return false
}
export class NativeDOM {
  // biome-ignore lint/suspicious/noExplicitAny: window shape is arbitrary BotGuard-facing object
  public window: any

  constructor(options: { url: string; referrer: string; userAgent: string }) {
    _init()

    const {
      EventTarget,
      Node,
      Element,
      HTMLElement,
      HTMLIFrameElement,
      HTMLCanvasElement,
      HTMLImageElement,
      HTMLDivElement,
      HTMLBodyElement,
      HTMLHtmlElement,
      Window,
      Document,
      HTMLDocument,
      Navigator,
      Location,
      Performance,
      Screen,
      CSSStyleDeclaration,
      PluginArray,
      MimeTypeArray,
      Scheduler,
      getDummyConstructor,
      getEventCtorProto
    } = _classes

    const urlObj = new URL(options.url)

    const performanceMock: AnyObj = Object.create(Performance.prototype)
    performanceMock.now = () => performance.now()
    performanceMock.timeOrigin = performance.timeOrigin

    const locationMock: AnyObj = Object.create(Location.prototype)
    locationMock.href = options.url
    locationMock.origin = urlObj.origin
    locationMock.protocol = urlObj.protocol
    locationMock.host = urlObj.host
    locationMock.hostname = urlObj.hostname
    locationMock.pathname = urlObj.pathname
    locationMock.search = urlObj.search
    locationMock.hash = urlObj.hash
    locationMock.ancestorOrigins = EMPTY_ARRAY
    locationMock.toString = () => options.url
    locationMock.valueOf = () => locationMock

    const navigatorMock: AnyObj = Object.create(Navigator.prototype)
    navigatorMock.userAgent = options.userAgent
    navigatorMock.languages = ['en-US', 'en']
    navigatorMock.platform = 'Win32'
    navigatorMock.appName = 'Netscape'
    navigatorMock.appCodeName = 'Mozilla'
    navigatorMock.plugins = Object.create(PluginArray.prototype)
    navigatorMock.mimeTypes = Object.create(MimeTypeArray.prototype)
    navigatorMock.cookieEnabled = true
    navigatorMock.onLine = true
    navigatorMock.hardwareConcurrency = 8
    navigatorMock.deviceMemory = 8
    navigatorMock.maxTouchPoints = 0
    navigatorMock.javaEnabled = () => false

    const TAG_PROTO_MAP: Record<string, object> = {
      iframe: HTMLIFrameElement.prototype,
      canvas: HTMLCanvasElement.prototype,
      img: HTMLImageElement.prototype,
      div: HTMLDivElement.prototype,
      body: HTMLBodyElement.prototype,
      html: HTMLHtmlElement.prototype
    }

    const cssProxyHandler: ProxyHandler<AnyObj> = {
      get(target, prop, receiver) {
        if (typeof prop === 'symbol') return Reflect.get(target, prop, receiver)
        if (prop === 'toString') return () => '[object CSSStyleDeclaration]'
        if (Reflect.has(target, prop) || Reflect.has(Object.prototype, prop)) {
          return Reflect.get(target, prop, receiver)
        }
        return ''
      },
      set() {
        return true
      }
    }

    const elementProxyHandler: ProxyHandler<AnyObj> = {
      get(target, prop, receiver) {
        if (typeof prop !== 'string') return Reflect.get(target, prop, receiver)
        if (Reflect.has(target, prop))
          return Reflect.get(target, prop, receiver)
        if (ELEMENT_STRING_PROPS.has(prop)) {
          const tag = target.tagName?.toLowerCase()
          if (prop === 'width' || prop === 'height') {
            if (tag === 'canvas') return prop === 'width' ? 300 : 150
            if (tag === 'img') return 0
            return ''
          }
          return ''
        }
        if (ELEMENT_BOOL_PROPS.has(prop)) return false
        if (ELEMENT_ZERO_PROPS.has(prop)) return 0
        if (prop === 'tabIndex') return -1
        return Reflect.get(target, prop, receiver)
      }
    }

    const createElement = (tagName: string): AnyObj => {
      const tag = tagName.toLowerCase()
      const proto = TAG_PROTO_MAP[tag] ?? HTMLElement.prototype

      const styleMock = new Proxy(
        Object.create(CSSStyleDeclaration.prototype),
        cssProxyHandler
      )

      const element: AnyObj = Object.create(proto)
      element.tagName = tag.toUpperCase()
      element.nodeName = element.tagName
      element.style = styleMock
      element.attributes = EMPTY_ARRAY

      if (tag === 'iframe') {
        let _contentWindow: AnyObj | null = null
        const buildIframe = () => {
          if (_contentWindow) return
          const subDocument: AnyObj = Object.create(HTMLDocument.prototype)
          subDocument.URL = 'about:blank'
          subDocument.referrer = options.url
          subDocument.readyState = 'complete'
          subDocument.defaultCharset = 'UTF-8'
          subDocument.hidden = false
          subDocument.createElement = createElement
          subDocument.createEvent = (type: string) =>
            documentMock.createEvent(type)
          subDocument.body = createElement('body')
          subDocument.documentElement = createElement('html')
          subDocument.getElementsByTagName = () => EMPTY_ARRAY
          subDocument.addEventListener = () => {}
          subDocument.removeEventListener = () => {}
          subDocument.hasFocus = () => true

          const subWindow: AnyObj = Object.create(Window.prototype)
          subWindow.document = subDocument
          subWindow.location = locationMock
          subWindow.origin = urlObj.origin
          subWindow.navigator = navigatorMock
          subWindow.performance = performanceMock
          subWindow.length = 0
          subWindow.TEMPORARY = 0
          subWindow.PERSISTENT = 1
          subWindow.scrollY = 0
          subWindow.scrollX = 0
          subWindow.btoa = windowMock.btoa
          subWindow.atob = windowMock.atob
          subWindow.close = () => {}
          Object.setPrototypeOf(subWindow, globalThis)
          subWindow.window = subWindow
          subWindow.self = subWindow
          subWindow.top = windowProxy
          subWindow.parent = windowProxy
          subWindow.frames = subWindow
          subDocument.defaultView = subWindow

          _contentWindow = makeWindowProxy(subWindow)
        }
        Object.defineProperty(element, 'contentWindow', {
          get() {
            buildIframe()
            return _contentWindow
          },
          configurable: true,
          enumerable: true
        })
        Object.defineProperty(element, 'contentDocument', {
          get() {
            buildIframe()
            return _contentWindow?.document ?? null
          },
          configurable: true,
          enumerable: true
        })
      } else if (tag === 'canvas') {
        element.getContext = (type: string) =>
          type === '2d' ? CANVAS_2D_CTX : null
      }

      return new Proxy(element, elementProxyHandler)
    }

    const createEvent = (type: string): AnyObj => {
      let constructorName = 'Event'
      for (let i = 0; i < EVENT_TYPE_KEYS.length; i++) {
        const key = EVENT_TYPE_KEYS[i]
        if (key !== undefined && type.includes(key)) {
          constructorName = EVENT_TYPE_MAP[key] ?? 'Event'
          break
        }
      }
      const event: AnyObj = Object.create(getEventCtorProto(constructorName))
      event.type = type
      event.timeStamp = performance.now()
      return event
    }

    const documentMock: AnyObj = Object.create(HTMLDocument.prototype)
    documentMock.URL = options.url
    documentMock.referrer = options.referrer
    documentMock.readyState = 'complete'
    documentMock.defaultCharset = 'UTF-8'
    documentMock.hidden = false
    documentMock.location = locationMock
    documentMock.body = createElement('body')
    documentMock.documentElement = createElement('html')
    documentMock.createElement = createElement
    documentMock.createEvent = createEvent
    documentMock.getElementsByTagName = (name: string) => {
      const tag = name.toLowerCase()
      if (tag === 'head' || tag === 'body' || tag === 'html')
        return [createElement(tag)]
      return EMPTY_ARRAY
    }
    documentMock.getElementsByTagNameNS = (_ns: string, name: string) =>
      documentMock.getElementsByTagName(name)
    documentMock.addEventListener = () => {}
    documentMock.removeEventListener = () => {}
    documentMock.hasFocus = () => true

    const windowMock: AnyObj = Object.create(Window.prototype)
    windowMock.document = documentMock
    windowMock.location = locationMock
    windowMock.origin = urlObj.origin
    windowMock.navigator = navigatorMock
    windowMock.performance = performanceMock
    windowMock.name = ''
    windowMock.innerHeight = 1080
    windowMock.innerWidth = 1920
    windowMock.outerHeight = 1080
    windowMock.outerWidth = 1920
    windowMock.screenX = 0
    windowMock.screenY = 0
    windowMock.screenLeft = 0
    windowMock.screenTop = 0
    windowMock.devicePixelRatio = 1
    windowMock.screen = Object.assign(Object.create(Screen.prototype), {
      width: 1920,
      height: 1080,
      availWidth: 1920,
      availHeight: 1080,
      colorDepth: 24,
      pixelDepth: 24
    })
    windowMock.length = 0
    windowMock.TEMPORARY = 0
    windowMock.PERSISTENT = 1
    windowMock.scrollY = 0
    windowMock.scrollX = 0
    windowMock.btoa = (str: string) =>
      Buffer.from(str, 'binary').toString('base64')
    windowMock.atob = (str: string) =>
      Buffer.from(str, 'base64').toString('binary')
    windowMock.close = () => {}
    windowMock.getComputedStyle = (el: AnyObj) => el.style || {}
    windowMock.cancelIdleCallback = () => {}
    windowMock.requestIdleCallback = (cb: () => void) => setTimeout(cb, 1)
    windowMock.credentialless = false
    windowMock.offscreenBuffering = true
    windowMock.isSecureContext = true
    windowMock.reportError = (err: unknown) => {
      console.error(err)
    }
    windowMock.history = {
      length: 1,
      scrollRestoration: 'auto',
      state: null,
      back() {},
      forward() {},
      go() {},
      pushState() {},
      replaceState() {}
    }
    windowMock.sharedStorage = {}
    windowMock.scheduler = new Scheduler()
    windowMock.fetchLater = () => DEFERRED_REQUEST_OBJ

    Object.assign(windowMock, {
      EventTarget,
      Window,
      Document,
      HTMLDocument,
      Navigator,
      Location,
      Performance,
      PluginArray,
      MimeTypeArray,
      CSSStyleDeclaration,
      Screen,
      Node,
      Element,
      HTMLElement,
      HTMLIFrameElement,
      HTMLCanvasElement,
      HTMLImageElement,
      HTMLDivElement,
      HTMLBodyElement,
      HTMLHtmlElement,
      Scheduler
    })

    const makeWindowProxy = (winTarget: AnyObj) =>
      new Proxy(winTarget, {
        has(target, prop) {
          if (typeof prop !== 'string') return Reflect.has(target, prop)
          if (Reflect.has(target, prop) || Reflect.has(globalThis, prop))
            return true
          if (isConstructorName(prop)) return true
          return (
            prop.length > 2 &&
            prop.charCodeAt(0) === 111 &&
            prop.charCodeAt(1) === 110
          )
        },
        getOwnPropertyDescriptor(target, prop) {
          if (typeof prop !== 'string')
            return Reflect.getOwnPropertyDescriptor(target, prop)
          if (Reflect.has(target, prop))
            return Reflect.getOwnPropertyDescriptor(target, prop)
          if (isConstructorName(prop)) {
            return {
              value: getDummyConstructor(prop),
              writable: true,
              enumerable: true,
              configurable: true
            }
          }
          if (
            prop.length > 2 &&
            prop.charCodeAt(0) === 111 &&
            prop.charCodeAt(1) === 110
          ) {
            return {
              value: null,
              writable: true,
              enumerable: true,
              configurable: true
            }
          }
          if (Reflect.has(globalThis, prop))
            return Reflect.getOwnPropertyDescriptor(globalThis, prop)
          return Reflect.getOwnPropertyDescriptor(target, prop)
        },
        get(target, prop, receiver) {
          if (typeof prop !== 'string')
            return Reflect.get(target, prop, receiver)
          if (
            prop === 'window' ||
            prop === 'self' ||
            prop === 'top' ||
            prop === 'parent' ||
            prop === 'frames'
          ) {
            return receiver
          }
          if (Reflect.has(target, prop))
            return Reflect.get(target, prop, receiver)
          if (isConstructorName(prop)) return getDummyConstructor(prop)
          if (
            prop.length > 2 &&
            prop.charCodeAt(0) === 111 &&
            prop.charCodeAt(1) === 110
          )
            return null
          if (Reflect.has(globalThis, prop))
            return Reflect.get(globalThis, prop)
          return Reflect.get(target, prop, receiver)
        }
      })

    // windowProxy must exist before iframe sub-windows reference it.
    let windowProxy: AnyObj
    windowProxy = makeWindowProxy(windowMock)
    documentMock.defaultView = windowProxy
    this.window = windowProxy
  }
}
