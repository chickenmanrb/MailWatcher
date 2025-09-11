import { logger } from '../utils/logger.js';

export interface FuzzyMatchResult {
  match: string;
  score: number;
  originalIndex: number;
}

export class FuzzyMatcher {
  private static levenshteinDistance(a: string, b: string): number {
    const matrix: number[][] = [];
    
    for (let i = 0; i <= b.length; i++) {
      matrix[i] = [i];
    }
    
    for (let j = 0; j <= a.length; j++) {
      matrix[0][j] = j;
    }
    
    for (let i = 1; i <= b.length; i++) {
      for (let j = 1; j <= a.length; j++) {
        if (b.charAt(i - 1) === a.charAt(j - 1)) {
          matrix[i][j] = matrix[i - 1][j - 1];
        } else {
          matrix[i][j] = Math.min(
            matrix[i - 1][j - 1] + 1,
            matrix[i][j - 1] + 1,
            matrix[i - 1][j] + 1
          );
        }
      }
    }
    
    return matrix[b.length][a.length];
  }

  static calculateSimilarity(str1: string, str2: string): number {
    const s1 = str1.toLowerCase().trim();
    const s2 = str2.toLowerCase().trim();
    
    if (s1 === s2) return 1.0;
    if (s1.length === 0 || s2.length === 0) return 0.0;
    
    const distance = this.levenshteinDistance(s1, s2);
    const maxLength = Math.max(s1.length, s2.length);
    return 1 - (distance / maxLength);
  }

  static containsSimilar(haystack: string, needle: string, threshold: number = 0.8): boolean {
    const h = haystack.toLowerCase();
    const n = needle.toLowerCase();
    
    if (h.includes(n)) return true;
    
    const words = h.split(/\s+/);
    for (const word of words) {
      if (this.calculateSimilarity(word, n) >= threshold) {
        return true;
      }
    }
    
    for (let i = 0; i <= h.length - n.length; i++) {
      const substring = h.substring(i, i + n.length);
      if (this.calculateSimilarity(substring, n) >= threshold) {
        return true;
      }
    }
    
    return false;
  }

  static findBestMatch(
    target: string,
    candidates: string[],
    threshold: number = 0.6
  ): FuzzyMatchResult | null {
    let bestMatch: FuzzyMatchResult | null = null;
    
    for (let i = 0; i < candidates.length; i++) {
      const score = this.calculateSimilarity(target, candidates[i]);
      
      if (score >= threshold) {
        if (!bestMatch || score > bestMatch.score) {
          bestMatch = {
            match: candidates[i],
            score,
            originalIndex: i,
          };
        }
      }
    }
    
    if (bestMatch) {
      logger.debug('FuzzyMatcher', `Found match for "${target}"`, bestMatch);
    }
    
    return bestMatch;
  }

  static findAllMatches(
    target: string,
    candidates: string[],
    threshold: number = 0.6
  ): FuzzyMatchResult[] {
    const matches: FuzzyMatchResult[] = [];
    
    for (let i = 0; i < candidates.length; i++) {
      const score = this.calculateSimilarity(target, candidates[i]);
      
      if (score >= threshold) {
        matches.push({
          match: candidates[i],
          score,
          originalIndex: i,
        });
      }
    }
    
    return matches.sort((a, b) => b.score - a.score);
  }

  static tokenSimilarity(str1: string, str2: string): number {
    const tokens1 = new Set(str1.toLowerCase().split(/\W+/).filter(t => t.length > 0));
    const tokens2 = new Set(str2.toLowerCase().split(/\W+/).filter(t => t.length > 0));
    
    if (tokens1.size === 0 || tokens2.size === 0) return 0;
    
    let matchCount = 0;
    for (const token of tokens1) {
      if (tokens2.has(token)) {
        matchCount++;
      } else {
        for (const token2 of tokens2) {
          if (this.calculateSimilarity(token, token2) >= 0.85) {
            matchCount += 0.8;
            break;
          }
        }
      }
    }
    
    const union = new Set([...tokens1, ...tokens2]);
    return matchCount / union.size;
  }

  static isFieldMatch(
    fieldDescriptor: string,
    targetPattern: string | RegExp,
    options: { fuzzyThreshold?: number; tokenMatch?: boolean } = {}
  ): boolean {
    const { fuzzyThreshold = 0.7, tokenMatch = true } = options;
    
    if (targetPattern instanceof RegExp) {
      return targetPattern.test(fieldDescriptor);
    }
    
    const descriptor = fieldDescriptor.toLowerCase();
    const target = targetPattern.toLowerCase();
    
    if (descriptor.includes(target)) return true;
    
    if (tokenMatch) {
      const tokenScore = this.tokenSimilarity(descriptor, target);
      if (tokenScore >= fuzzyThreshold) return true;
    }
    
    const words = descriptor.split(/[\s\-_]+/);
    for (const word of words) {
      if (this.calculateSimilarity(word, target) >= fuzzyThreshold) {
        return true;
      }
    }
    
    return false;
  }
}

export class FieldMatcher {
  private patterns: Map<string, { exact?: string[]; fuzzy?: string[]; regex?: RegExp[] }> = new Map();

  constructor() {
    this.initializePatterns();
  }

  private initializePatterns() {
    this.patterns.set('email', {
      exact: ['email', 'e-mail', 'mail', 'emailaddress', 'email_address'],
      fuzzy: ['electronic mail', 'email addr', 'e mail'],
      regex: [/e[\-_]?mail/i, /mail.*addr/i],
    });

    this.patterns.set('firstName', {
      exact: ['firstname', 'first_name', 'fname', 'given_name', 'givenname'],
      fuzzy: ['first name', 'given name', 'forename'],
      regex: [/first.*name/i, /given.*name/i, /^f\.?name$/i],
    });

    this.patterns.set('lastName', {
      exact: ['lastname', 'last_name', 'lname', 'surname', 'family_name', 'familyname'],
      fuzzy: ['last name', 'family name', 'sur name'],
      regex: [/last.*name/i, /family.*name/i, /sur.*name/i, /^l\.?name$/i],
    });

    this.patterns.set('phone', {
      exact: ['phone', 'telephone', 'tel', 'mobile', 'cell', 'phonenumber', 'phone_number'],
      fuzzy: ['phone number', 'telephone number', 'contact number', 'mobile number'],
      regex: [/phone/i, /tel/i, /mobile/i, /cell/i, /contact.*num/i],
    });

    this.patterns.set('company', {
      exact: ['company', 'organization', 'organisation', 'employer', 'business', 'firm'],
      fuzzy: ['company name', 'organization name', 'business name', 'employer name'],
      regex: [/company/i, /org(aniz|anis)ation/i, /employer/i, /business/i],
    });

    this.patterns.set('address', {
      exact: ['address', 'street', 'streetaddress', 'street_address', 'addr'],
      fuzzy: ['street address', 'mailing address', 'physical address'],
      regex: [/street/i, /address/i, /addr(?!ess2)/i],
    });

    this.patterns.set('city', {
      exact: ['city', 'town', 'municipality', 'locality'],
      fuzzy: ['city name', 'town name'],
      regex: [/city/i, /town/i, /municipality/i],
    });

    this.patterns.set('state', {
      exact: ['state', 'province', 'region', 'territory'],
      fuzzy: ['state province', 'state or province'],
      regex: [/state/i, /province/i, /region/i],
    });

    this.patterns.set('zip', {
      exact: ['zip', 'zipcode', 'zip_code', 'postal', 'postalcode', 'postal_code', 'postcode'],
      fuzzy: ['zip code', 'postal code', 'post code'],
      regex: [/zip/i, /postal/i, /post.*code/i],
    });

    this.patterns.set('country', {
      exact: ['country', 'nation', 'countryname', 'country_name'],
      fuzzy: ['country name', 'nation name'],
      regex: [/country/i, /nation/i],
    });
  }

  matchField(descriptor: string, threshold: number = 0.7): string | null {
    const desc = descriptor.toLowerCase().trim();
    
    for (const [fieldType, patterns] of this.patterns) {
      if (patterns.exact?.some(p => desc.includes(p))) {
        logger.debug('FieldMatcher', `Exact match for ${fieldType}: ${descriptor}`);
        return fieldType;
      }
      
      if (patterns.regex?.some(r => r.test(desc))) {
        logger.debug('FieldMatcher', `Regex match for ${fieldType}: ${descriptor}`);
        return fieldType;
      }
      
      if (patterns.fuzzy) {
        for (const fuzzyPattern of patterns.fuzzy) {
          if (FuzzyMatcher.tokenSimilarity(desc, fuzzyPattern) >= threshold) {
            logger.debug('FieldMatcher', `Fuzzy match for ${fieldType}: ${descriptor}`);
            return fieldType;
          }
        }
      }
    }
    
    return null;
  }

  addPattern(fieldType: string, exact?: string[], fuzzy?: string[], regex?: RegExp[]) {
    const existing = this.patterns.get(fieldType) || {};
    this.patterns.set(fieldType, {
      exact: [...(existing.exact || []), ...(exact || [])],
      fuzzy: [...(existing.fuzzy || []), ...(fuzzy || [])],
      regex: [...(existing.regex || []), ...(regex || [])],
    });
  }
}

export const fieldMatcher = new FieldMatcher();