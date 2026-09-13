import { http1makeRequest } from '../utils.js';
/**
 * Fallback key used when no custom Google Translate key is configured.
 * @internal
 */
const DEFAULT_API_KEY = 'AIzaSyDLEeFI5OtFBwYBIoK_jj5m32rZK5CkCXA';
/**
 * Google Translate endpoint used by the lightweight translation helpers.
 * @internal
 */
const GOOGLE_TRANSLATE_ENDPOINT = 'https://translate-pa.googleapis.com/v1/translate';
/**
 * Supported language code map for Google Translate.
 * @public
 */
export const GoogleLanguages = {
    auto: 'Detect language',
    af: 'Afrikaans',
    sq: 'Albanian',
    am: 'Amharic',
    ar: 'Arabic',
    hy: 'Armenian',
    as: 'Assamese',
    ay: 'Aymara',
    az: 'Azerbaijani',
    bm: 'Bambara',
    eu: 'Basque',
    be: 'Belarusian',
    bn: 'Bengali',
    bho: 'Bhojpuri',
    bs: 'Bosnian',
    bg: 'Bulgarian',
    ca: 'Catalan',
    ceb: 'Cebuano',
    ny: 'Chichewa',
    'zh-CN': 'Chinese (Simplified)',
    'zh-TW': 'Chinese (Traditional)',
    co: 'Corsican',
    hr: 'Croatian',
    cs: 'Czech',
    da: 'Danish',
    dv: 'Dhivehi',
    doi: 'Dogri',
    nl: 'Dutch',
    en: 'English',
    eo: 'Esperanto',
    et: 'Estonian',
    ee: 'Ewe',
    tl: 'Filipino',
    fi: 'Finnish',
    fr: 'French',
    fy: 'Frisian',
    gl: 'Galician',
    ka: 'Georgian',
    de: 'German',
    el: 'Greek',
    gn: 'Guarani',
    gu: 'Gujarati',
    ht: 'Haitian Creole',
    ha: 'Hausa',
    haw: 'Hawaiian',
    iw: 'Hebrew',
    hi: 'Hindi',
    hmn: 'Hmong',
    hu: 'Hungarian',
    is: 'Icelandic',
    ig: 'Igbo',
    ilo: 'Ilocano',
    id: 'Indonesian',
    ga: 'Irish',
    it: 'Italian',
    ja: 'Japanese',
    jw: 'Javanese',
    kn: 'Kannada',
    kk: 'Kazakh',
    km: 'Khmer',
    rw: 'Kinyarwanda',
    gom: 'Konkani',
    ko: 'Korean',
    kri: 'Krio',
    ku: 'Kurdish (Kurmanji)',
    ckb: 'Kurdish (Sorani)',
    ky: 'Kyrgyz',
    lo: 'Lao',
    la: 'Latin',
    lv: 'Latvian',
    ln: 'Lingala',
    lt: 'Lithuanian',
    lg: 'Luganda',
    lb: 'Luxembourgish',
    mk: 'Macedonian',
    mai: 'Maithili',
    mg: 'Malagasy',
    ms: 'Malay',
    ml: 'Malayalam',
    mt: 'Maltese',
    mi: 'Maori',
    mr: 'Marathi',
    'mni-Mtei': 'Meiteilon (Manipuri)',
    lus: 'Mizo',
    mn: 'Mongolian',
    my: 'Myanmar (Burmese)',
    ne: 'Nepali',
    no: 'Norwegian',
    or: 'Odia (Oriya)',
    om: 'Oromo',
    ps: 'Pashto',
    fa: 'Persian',
    pl: 'Polish',
    pt: 'Portuguese',
    pa: 'Punjabi',
    qu: 'Quechua',
    ro: 'Romanian',
    ru: 'Russian',
    sm: 'Samoan',
    sa: 'Sanskrit',
    gd: 'Scots Gaelic',
    nso: 'Sepedi',
    sr: 'Serbian',
    st: 'Sesotho',
    sn: 'Shona',
    sd: 'Sindhi',
    si: 'Sinhala',
    sk: 'Slovak',
    sl: 'Slovenian',
    so: 'Somali',
    es: 'Spanish',
    su: 'Sundanese',
    sw: 'Swahili',
    sv: 'Swedish',
    tg: 'Tajik',
    ta: 'Tamil',
    tt: 'Tatar',
    te: 'Telugu',
    th: 'Thai',
    ti: 'Tigrinya',
    ts: 'Tsonga',
    tr: 'Turkish',
    tk: 'Turkmen',
    ak: 'Twi',
    uk: 'Ukrainian',
    ur: 'Urdu',
    ug: 'Uyghur',
    uz: 'Uzbek',
    vi: 'Vietnamese',
    cy: 'Welsh',
    xh: 'Xhosa',
    yi: 'Yiddish',
    yo: 'Yoruba',
    zu: 'Zulu'
};
/**
 * Builds the full request URL for Google Translate endpoint.
 * @param text - Text to translate.
 * @param sourceLang - Source language code.
 * @param targetLang - Target language code.
 * @param apiKey - API key for the endpoint.
 * @returns Fully qualified request URL.
 * @internal
 */
const buildTranslateUrl = (text, sourceLang, targetLang, apiKey) => {
    const params = new URLSearchParams({
        'params.client': 'gtx',
        dataTypes: 'TRANSLATION',
        key: apiKey,
        'query.sourceLanguage': sourceLang,
        'query.targetLanguage': targetLang,
        'query.text': text
    });
    return `${GOOGLE_TRANSLATE_ENDPOINT}?${params}`;
};
/**
 * Translates a single text payload.
 * @param text - Text to translate.
 * @param sourceLang - Source language code.
 * @param targetLang - Target language code.
 * @param apiKey - Optional API key override.
 * @returns Translation result with text and source language.
 * @throws Error when API call fails or response is invalid.
 * @public
 */
export async function translateText(text, sourceLang, targetLang, apiKey) {
    if (!text)
        return { translation: '', sourceLanguage: sourceLang };
    const key = apiKey || process.env.GOOGLE_TRANSLATE_KEY || DEFAULT_API_KEY;
    const url = buildTranslateUrl(text, sourceLang, targetLang, key);
    const { body, statusCode, error } = await http1makeRequest(url, {
        method: 'GET'
    });
    const payload = body;
    if (error || statusCode !== 200 || !payload?.translation) {
        throw new Error(`Translate failed: ${error || statusCode}`);
    }
    return {
        translation: payload.translation,
        sourceLanguage: payload.sourceLanguage || sourceLang
    };
}
/**
 * Translates a list of texts sequentially.
 * @param texts - Text list to translate.
 * @param sourceLang - Source language code.
 * @param targetLang - Target language code.
 * @param apiKey - Optional API key override.
 * @returns Array of translated text values.
 * @public
 */
export async function translateMany(texts, sourceLang, targetLang, apiKey) {
    const results = [];
    for (const text of texts) {
        const res = await translateText(text, sourceLang, targetLang, apiKey);
        results.push(res.translation);
    }
    return results;
}
