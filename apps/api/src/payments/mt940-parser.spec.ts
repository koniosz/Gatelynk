// Testy jednostkowe parsera MT940 — 3 fixture'y odwzorowujące realne
// warianty polskich banków: mBank/PKO (~ subpola), ING (< subpola w liniach)
// oraz plik generyczny bez subpól. Plus dekodowanie windows-1250.
import { decodeMt940Buffer, parseMt940 } from './mt940-parser'

// ── Fixture 1: styl mBank/PKO — subpola ~NN, CRLF, kredyt + debet ────────────
const FIXTURE_MBANK = [
  ':20:ST062026',
  ':25:PL27114020040000300201355387',
  ':28C:00123/001',
  ':60F:C260630PLN15000,00',
  ':61:2607010701C450,00N062NONREF//BR20260701001',
  ':86:020~00B062~20CZYNSZ LOKAL 15A LIPIEC 2026~21ANNA KOWALSKA~22~23~24~25',
  '~3011402004~310000345~32ANNA KOWALSKA~33~34000~38PL61109010140000071219812874',
  ':61:2607020702D89,99N152NONREF//BR20260702017',
  ':86:073~00B152~20OPLATA ZA PRAD~32PGE OBROT SA',
  ':61:2607030703C1250,00N062NONREF//BR20260703004',
  ':86:020~00B062~20CZYNSZ M. 15B~21LIPIEC~32PIOTR ZIELINSKI~38PL02103000190109850300071988',
  ':62F:C260731PLN16610,01',
  '-',
].join('\r\n')

// ── Fixture 2: styl ING — subpola <NN, każde w osobnej linii ─────────────────
const FIXTURE_ING = [
  ':20:MT940',
  ':25:PL61109010140000071219812874',
  ':28C:123',
  ':60F:C260601PLN1000,00',
  ':61:260605C1200,50N240NONREF',
  ':86:<20Czynsz 6/2026 lokal 15C',
  '<21fundusz remontowy',
  '<27JAN NOWAK',
  '<32JAN NOWAK',
  ':62F:C260630PLN2200,50',
].join('\n')

// ── Fixture 3: generyczny — transakcja BEZ subpól w :86: i jedna bez :86: ────
const FIXTURE_PLAIN = [
  ':20:WYCIAG001',
  ':25:12345678901234567890123456',
  ':28C:1/2026',
  ':60F:C260701PLN500,00',
  ':61:260710C300,00NTRFREF123456',
  ':86:PRZELEW PRZYCHODZACY CZYNSZ LOKAL 2 KOWALSCY',
  ':61:260711C42,00NTRF//XYZ1',
  ':62F:C260731PLN842,00',
].join('\n')

describe('parseMt940', () => {
  describe('fixture mBank (~ subpola, CRLF)', () => {
    const stmt = parseMt940(FIXTURE_MBANK)

    it('parsuje nagłówki wyciągu', () => {
      expect(stmt.reference).toBe('ST062026')
      expect(stmt.accountNumber).toBe('PL27114020040000300201355387')
      expect(stmt.statementNumber).toBe('00123/001')
      expect(stmt.openingBalance).toBe(15000)
      expect(stmt.closingBalance).toBe(16610.01)
      expect(stmt.currency).toBe('PLN')
    })

    it('parsuje 3 transakcje z prawidłowym kierunkiem i kwotą', () => {
      expect(stmt.transactions).toHaveLength(3)
      const [t1, t2, t3] = stmt.transactions
      expect(t1.direction).toBe('C')
      expect(t1.amount).toBe(450)
      expect(t2.direction).toBe('D')
      expect(t2.amount).toBe(89.99)
      expect(t3.direction).toBe('C')
      expect(t3.amount).toBe(1250)
    })

    it('wyciąga datę waluty YYMMDD → 2026', () => {
      const t1 = stmt.transactions[0]
      expect(t1.valueDate.getUTCFullYear()).toBe(2026)
      expect(t1.valueDate.getUTCMonth()).toBe(6) // lipiec (0-based)
      expect(t1.valueDate.getUTCDate()).toBe(1)
    })

    it('wyciąga referencję bankową po //', () => {
      expect(stmt.transactions[0].reference).toBe('BR20260701001')
    })

    it('wyciąga tytuł z ~20-~25 i nadawcę z ~32 (multiline kontynuacja)', () => {
      const t1 = stmt.transactions[0]
      expect(t1.title).toContain('CZYNSZ LOKAL 15A LIPIEC 2026')
      expect(t1.title).toContain('ANNA KOWALSKA')
      expect(t1.senderName).toContain('ANNA KOWALSKA')
      expect(t1.senderAccount).toBe('PL61109010140000071219812874')

      const t3 = stmt.transactions[2]
      expect(t3.title).toContain('CZYNSZ M. 15B')
      expect(t3.senderName).toContain('PIOTR ZIELINSKI')
    })
  })

  describe('fixture ING (< subpola w liniach)', () => {
    const stmt = parseMt940(FIXTURE_ING)

    it('parsuje transakcję bez daty księgowania i bez //', () => {
      expect(stmt.transactions).toHaveLength(1)
      const t = stmt.transactions[0]
      expect(t.direction).toBe('C')
      expect(t.amount).toBe(1200.5)
      expect(t.reference).toBeNull() // NONREF → null
    })

    it('wyciąga tytuł i nadawcę z subpól <NN', () => {
      const t = stmt.transactions[0]
      expect(t.title).toContain('Czynsz 6/2026 lokal 15C')
      expect(t.title).toContain('fundusz remontowy')
      expect(t.senderName).toContain('JAN NOWAK')
    })
  })

  describe('fixture generyczny (bez subpól)', () => {
    const stmt = parseMt940(FIXTURE_PLAIN)

    it('parsuje transakcje: z surowym opisem oraz bez :86:', () => {
      expect(stmt.transactions).toHaveLength(2)
      const [t1, t2] = stmt.transactions
      expect(t1.title).toBeNull()
      expect(t1.senderName).toBeNull()
      expect(t1.rawDetails).toContain('CZYNSZ LOKAL 2 KOWALSCY')
      expect(t1.reference).toBe('REF123456') // ref klienta po kodzie NTRF
      expect(t2.rawDetails).toBe('')
      expect(t2.amount).toBe(42)
    })
  })

  it('ignoruje storna (RC) jako reversal, kierunek C', () => {
    const stmt = parseMt940([
      ':20:X',
      ':61:260701RC100,00NTRF//A1',
      ':86:ZWROT',
    ].join('\n'))
    expect(stmt.transactions).toHaveLength(1)
    expect(stmt.transactions[0].direction).toBe('C')
    expect(stmt.transactions[0].reversal).toBe(true)
  })

  it('nie wywala się na pustym pliku / śmieciach', () => {
    expect(parseMt940('').transactions).toHaveLength(0)
    expect(parseMt940('hello world\nfoo').transactions).toHaveLength(0)
  })
})

describe('decodeMt940Buffer', () => {
  it('dekoduje poprawny UTF-8', () => {
    const buf = Buffer.from('CZYNSZ ŁUKASZ KOWALSKI', 'utf8')
    expect(decodeMt940Buffer(buf)).toBe('CZYNSZ ŁUKASZ KOWALSKI')
  })

  it('dekoduje windows-1250 (polskie znaki)', () => {
    // "MICHAŁ GĄSKA" w cp1250: Ł=0xA3, Ą=0xA5
    const bytes = [...Buffer.from('MICHA', 'ascii'), 0xa3, 0x20, 0x47, 0xa5, ...Buffer.from('SKA', 'ascii')]
    const decoded = decodeMt940Buffer(Buffer.from(bytes))
    expect(decoded).toBe('MICHAŁ GĄSKA')
  })
})
