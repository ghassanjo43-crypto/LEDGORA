# Arabic finance glossary — review this FIRST

## Why this file exists

There are ~3,045 strings to translate. Reviewing all of them is not a realistic
ask of anyone. But most of the *risk* is concentrated in maybe sixty recurring
accounting terms: get `receivable` or `journal entry` wrong once here and it is
wrong in three hundred places, and correcting it afterwards means three hundred
edits instead of one.

So: **review this table before the bulk translation continues.** Everything
below is my rendering, not a native speaker's. Jordanian/Levantine practice may
differ from Gulf or Egyptian usage, and where it does, yours wins.

Mark a row `✗` and give the preferred term; I will apply it everywhere and keep
it consistent from then on.

## Status

| | |
|---|---|
| Reviewed by | — *(pending)* |
| Date | — |

## Core accounting

| English | Proposed Arabic | Notes / uncertainty | OK? |
|---|---|---|---|
| Account | حساب | | |
| Chart of accounts | شجرة الحسابات | Also دليل الحسابات — which is standard in Jordan? | |
| Journal entry | قيد يومية | | |
| General journal | دفتر اليومية العام | | |
| General ledger | دفتر الأستاذ العام | | |
| Debit | مدين | | |
| Credit | دائن | | |
| Posting | ترحيل | | |
| Trial balance | ميزان المراجعة | | |
| Opening balance | رصيد افتتاحي | | |
| Balance due | الرصيد المستحق | | |
| Fiscal period | الفترة المالية | | |
| Reversal | قيد عكسي | For a reversing entry specifically | |

## Receivables / payables

| English | Proposed Arabic | Notes / uncertainty | OK? |
|---|---|---|---|
| Trade receivables | ذمم مدينة | Also الذمم المدينة التجارية | |
| Trade payables | ذمم دائنة | | |
| Customer | عميل | | |
| Supplier / vendor | مورّد | | |
| Receipt (money in) | سند قبض | Distinct from "receipt" as proof-of-purchase | |
| Payment (money out) | سند صرف | | |
| Credit note | إشعار دائن | | |
| Debit note | إشعار مدين | | |

## Documents

| English | Proposed Arabic | Notes / uncertainty | OK? |
|---|---|---|---|
| Invoice | فاتورة | | |
| Sales invoice | فاتورة مبيعات | | |
| Bill (purchase invoice) | فاتورة مشتريات | | |
| Draft | مسودة | | |
| Issued | صادرة | | |
| Void | ملغاة | | |
| Line item | بند | | |
| Unit price | سعر الوحدة | | |
| Discount | خصم | | |
| Subtotal | المجموع الفرعي | | |
| Grand total | الإجمالي | | |

## Tax

| English | Proposed Arabic | Notes / uncertainty | OK? |
|---|---|---|---|
| Tax | ضريبة | | |
| General sales tax | ضريبة المبيعات العامة | Jordan's GST — confirm the official ISTD wording | |
| Tax number | الرقم الضريبي | | |
| Output tax | ضريبة المخرجات | | |
| Input tax | ضريبة المدخلات | | |
| Zero-rated | خاضعة بنسبة صفر | | |
| Exempt | معفاة | | |
| Income source sequence | تسلسل مصدر الدخل | JoFotara term — confirm against ISTD docs | |

## Inventory & costing

| English | Proposed Arabic | Notes / uncertainty | OK? |
|---|---|---|---|
| Item | صنف | | |
| Warehouse | مستودع | | |
| Stock movement | حركة مخزون | | |
| Cost of sales | تكلفة المبيعات | | |
| Cost center | مركز تكلفة | | |

## Product / platform

| English | Proposed Arabic | Notes / uncertainty | OK? |
|---|---|---|---|
| Company | شركة | | |
| Workspace | مساحة عمل | Does this read naturally, or is it too literal? | |
| Subscriber | مشترك | | |
| Subscription | اشتراك | | |
| Package / plan | باقة | | |
| Settings | الإعدادات | | |
| Dashboard | لوحة المعلومات | Also لوحة التحكم | |
| Report | تقرير | | |

## Conventions I have applied

- **Dates stay Gregorian.** Hijri is display-only and off by default. `cbc:IssueDate`
  is `xsd:date` — proleptic Gregorian — so a Hijri date there is schema-invalid.
- **Digits stay Latin (123) by default.** Arabic-Indic is an opt-in display
  preference. `Number('١٢٣')` is `NaN`, so these must never reach stored data.
- **Product name `LEDGORA` is not translated** and stays Latin.
- **Invoice numbers, IBANs and account codes** are wrapped in `<LtrText>`, which
  stops the bidi algorithm reordering `INV-2026-0001` into `0001-2026-INV`.
