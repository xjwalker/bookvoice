/**
 * Map franc ISO 639-3 codes to BCP 47 tags used by expo-speech.
 */
const FRANC_TO_BCP47: Record<string, string> = {
  eng: 'en-US',
  spa: 'es',
  fra: 'fr',
  deu: 'de',
  ita: 'it',
  por: 'pt',
  rus: 'ru',
  jpn: 'ja',
  zho: 'zh',
  kor: 'ko',
  nld: 'nl',
  pol: 'pl',
  swe: 'sv',
  dan: 'da',
  nor: 'no',
  fin: 'fi',
  tur: 'tr',
  ara: 'ar',
  hin: 'hi',
  tha: 'th',
  vie: 'vi',
  cat: 'ca',
  ron: 'ro',
  ces: 'cs',
  ell: 'el',
  heb: 'he',
  ukr: 'uk',
  hun: 'hu',
};

export function francToBcp47(francCode: string): string {
  return FRANC_TO_BCP47[francCode] ?? 'en-US';
}
