/**
 * Microdata Product extraction tests (2026-07-08).
 *
 * REALISATIONPAR_PDP is a trimmed VERBATIM sample recorded from a live polite
 * probe of https://realisationpar.com/the-christy-black/ on 2026-07-08
 * (BigCommerce stencil): Product itemscope wrapping the page, name on the
 * <h1>, one Offer scope whose price lives in a nested PriceSpecification of
 * <meta> tags (the availability meta even spans two lines), description on an
 * <article>, category ONLY in BreadcrumbList microdata, no image itemprop
 * (og:image is the only image source), zero JSON-LD blocks.
 */
import { describe, expect, it } from 'vitest';
import { extractMicrodata } from './microdata';
import { extractListingFromHtml, type JsonldStoreInfo } from './normalize';

const RP_STORE: JsonldStoreInfo = {
  domain: 'realisationpar.com',
  displayName: 'Réalisation Par',
  productUrlPattern: 'realisationpar\\.com/[^/]+/$',
};

const RP_URL = 'https://realisationpar.com/the-christy-black/';

/** trimmed verbatim capture (see header) — whitespace/attribute quirks kept */
const REALISATIONPAR_PDP = `<!DOCTYPE html>
<html lang="en">
<head>
<title>The Christy - Black</title>
<meta property="og:type" content="product" />
<meta property="og:title" content="The Christy - Black" />
<meta property="og:image" content="https://cdn11.bigcommerce.com/s-c3pn5ygarq/products/153/images/467/CHRISTY_BLACK_WEBUPDATE_STOREVIEW__57715__73111.1745310814.386.513.jpg?c=1" />
<meta property="og:availability" content="instock" />
</head>
<body>
  <div class="container">
           <ul class="breadcrumbs" itemscope itemtype="http://schema.org/BreadcrumbList">
        <li class="breadcrumb " itemprop="itemListElement" itemscope itemtype="http://schema.org/ListItem">
                <a href="https://realisationpar.com/" class="breadcrumb-label" itemprop="item"><span itemprop="name">Home</span></a>
            <meta itemprop="position" content="0" />
        </li>
        <li class="breadcrumb " itemprop="itemListElement" itemscope itemtype="http://schema.org/ListItem">
                <a href="https://realisationpar.com/shop/" class="breadcrumb-label" itemprop="item"><span itemprop="name">Shop</span></a>
            <meta itemprop="position" content="1" />
        </li>
        <li class="breadcrumb " itemprop="itemListElement" itemscope itemtype="http://schema.org/ListItem">
                <a href="https://realisationpar.com/mini-dresses/" class="breadcrumb-label" itemprop="item"><span itemprop="name">Mini Dresses</span></a>
            <meta itemprop="position" content="2" />
        </li>
        <li class="breadcrumb is-active" itemprop="itemListElement" itemscope itemtype="http://schema.org/ListItem">
                <a href="https://realisationpar.com/the-christy-black/" class="breadcrumb-label" itemprop="item"><span itemprop="name">The Christy - Black</span></a>
            <meta itemprop="position" content="3" />
        </li>
</ul>

    <div itemscope itemtype="http://schema.org/Product" class="product_page" >
        <script>
    var combo_product = false;
</script>
                    <h1 class="productView-title" itemprop="name" >The Christy - Black</h1>
        <div class="price-section price-section--withoutTax" itemprop="offers" itemscope itemtype="http://schema.org/Offer">
            <span data-product-price-without-tax class="price price--withoutTax">$200.00

\t\t\t</span>
                <meta itemprop="availability" itemtype="http://schema.org/ItemAvailability"
                    content="http://schema.org/InStock">
                <meta itemprop="itemCondition" itemtype="http://schema.org/OfferItemCondition" content="http://schema.org/Condition">
                <div itemprop="priceSpecification" itemscope itemtype="http://schema.org/PriceSpecification">
                    <meta itemprop="price" content="200">
                    <meta itemprop="priceCurrency" content="USD">
                    <meta itemprop="valueAddedTaxIncluded" content="false">
                </div>

        </div>
        <article class="productView-description"  itemprop="description" >
        <p><strong>The Story:<br /></strong>The Christy is&nbsp;just about as perfect as a dress can get - that mid thigh length, adjustable spaghetti straps, and everything else a mini dress has to offer.</p>
<p><strong>Notes:<br /></strong>Our Dreamgirls: Alex 5'3 wears S and Gabriella 5'9 wears XS.</p>
<p><strong>Care:<br /></strong>100% Dupioni&nbsp;Silk<br />Dry-Clean only</p>
        </article>
    </div>
  </div>
</body>
</html>`;

describe('extractMicrodata — parser', () => {
  it('parses the recorded Réalisation Par PDP into JSON-LD-shaped nodes', () => {
    const micro = extractMicrodata(REALISATIONPAR_PDP);

    expect(micro.products).toHaveLength(1);
    const product = micro.products[0];
    expect(product['@type']).toBe('Product');
    expect(product.name).toBe('The Christy - Black');
    expect(String(product.description)).toContain('mini dress');
    expect(String(product.description)).toContain('Dupioni Silk'); // &nbsp; decoded

    // Offer scope with the nested PriceSpecification (metas, one spanning lines)
    const offer = product.offers as Record<string, unknown>;
    expect(offer['@type']).toBe('Offer');
    expect(offer.availability).toBe('http://schema.org/InStock');
    const spec = offer.priceSpecification as Record<string, unknown>;
    expect(spec.price).toBe('200');
    expect(spec.priceCurrency).toBe('USD');

    // breadcrumb trail (category source of last resort)
    expect(micro.breadcrumbs).toEqual(['Home', 'Shop', 'Mini Dresses', 'The Christy - Black']);
  });

  it('repeated itemprops arrayify; script bodies are skipped', () => {
    const micro = extractMicrodata(`
      <div itemscope itemtype="https://schema.org/Product">
        <script>if (1 < 2) { var itemprop = "<div itemprop='name'>bogus</div>"; }</script>
        <img itemprop="image" src="https://cdn/a.jpg">
        <img itemprop="image" src="https://cdn/b.jpg">
        <span itemprop="name">Dot Dress</span>
      </div>`);
    expect(micro.products[0].name).toBe('Dot Dress');
    expect(micro.products[0].image).toEqual(['https://cdn/a.jpg', 'https://cdn/b.jpg']);
  });

  it('tolerates malformed markup: unclosed elements, stray close tags, EOF inside a scope', () => {
    const micro = extractMicrodata(`
      <div itemscope itemtype="http://schema.org/Product">
        </table>
        <p itemprop="name">Torn Dress
        <div itemprop="offers" itemscope itemtype="http://schema.org/Offer">
          <meta itemprop="price" content="80">`);
    expect(micro.products).toHaveLength(1);
    // the unclosed <p>'s text still lands (finalized when the parent closes/EOF)
    expect(String(micro.products[0].name)).toContain('Torn Dress');
    expect((micro.products[0].offers as Record<string, unknown>).price).toBe('80');
  });

  it('returns empty results on pages without microdata (never throws)', () => {
    expect(extractMicrodata('<html><body><p>hi</p></body></html>').products).toEqual([]);
    expect(extractMicrodata('').products).toEqual([]);
    expect(extractMicrodata('<<<>>><div><span>').products).toEqual([]);
  });
});

describe('extractListingFromHtml — microdata fallback', () => {
  it('recorded Réalisation Par PDP → RawListing (category via breadcrumb, image via og:image)', () => {
    const { listing, outcome, via } = extractListingFromHtml(
      REALISATIONPAR_PDP,
      RP_STORE,
      RP_URL,
      1_000,
    );
    expect(outcome).toBe('ok');
    expect(via).toBe('microdata');
    expect(listing).toMatchObject({
      sourceId: 'jsonld:realisationpar.com',
      sourceListingId: 'the-christy-black', // URL slug — no sku/productID itemprops
      sourceUrl: RP_URL,
      title: 'The Christy - Black',
      brand: 'Réalisation Par', // no brand itemprop → store displayName
      priceCents: 20000,
      currency: 'USD',
      condition: 'new',
    });
    expect(listing!.imageUrls).toEqual([
      'https://cdn11.bigcommerce.com/s-c3pn5ygarq/products/153/images/467/CHRISTY_BLACK_WEBUPDATE_STOREVIEW__57715__73111.1745310814.386.513.jpg?c=1',
    ]);
    expect(listing!.description).toContain('mini dress');
    // breadcrumb 'Mini Dresses' also feeds the attribute hints
    expect(listing!.attributeHints?.lengthClass).toBe('mini');
  });

  it('non-dress microdata products are filtered by the breadcrumb category (live: Knitwear)', () => {
    // shape recorded from https://realisationpar.com/the-winona-cardigan-olive/
    const winona = REALISATIONPAR_PDP.replace(/The Christy - Black/g, 'The Winona Cardigan - Olive')
      .replace('Mini Dresses', 'Knitwear')
      .replace(/mini-dresses/g, 'knitwear');
    const { listing, outcome } = extractListingFromHtml(
      winona,
      RP_STORE,
      'https://realisationpar.com/the-winona-cardigan-olive/',
      1_000,
    );
    expect(listing).toBeNull();
    expect(outcome).toBe('not_a_dress');
  });

  it('JSON-LD is preferred when both JSON-LD and microdata carry a usable Product', () => {
    const both =
      `<script type="application/ld+json">${JSON.stringify({
        '@type': 'Product',
        name: 'Jsonld Midi Dress',
        sku: 'JL-1',
        image: 'https://cdn/jsonld.jpg',
        offers: { '@type': 'Offer', price: '120.00', priceCurrency: 'USD', availability: 'InStock' },
      })}</script>` + REALISATIONPAR_PDP;
    const { listing, via } = extractListingFromHtml(both, RP_STORE, RP_URL, 1_000);
    expect(via).toBe('jsonld');
    expect(listing).toMatchObject({ title: 'Jsonld Midi Dress', sourceListingId: 'JL-1', priceCents: 12000 });
  });

  it('falls back to microdata when the JSON-LD Product is unusable (no price)', () => {
    const unusableJsonld =
      `<script type="application/ld+json">${JSON.stringify({
        '@type': 'Product',
        name: 'The Christy - Black Dress',
        offers: [],
      })}</script>` + REALISATIONPAR_PDP;
    const { listing, via } = extractListingFromHtml(unusableJsonld, RP_STORE, RP_URL, 1_000);
    expect(via).toBe('microdata');
    expect(listing).toMatchObject({ title: 'The Christy - Black', priceCents: 20000 });
  });

  it('malformed microdata never crashes the page extraction (categorized miss)', () => {
    const mangled = '<div itemscope itemtype="http://schema.org/Product"><span itemprop="name">Half a Dre';
    const result = extractListingFromHtml(mangled, RP_STORE, RP_URL, 1_000);
    expect(result.listing).toBeNull();
    expect(['no_jsonld_product', 'not_a_dress', 'no_price']).toContain(result.outcome);
  });
});
