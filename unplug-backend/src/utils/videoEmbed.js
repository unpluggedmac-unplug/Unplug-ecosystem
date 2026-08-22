// Turning a pasted video link into something safe to put on a page.
//
// A writer pastes ONE link and the platform is worked out from it. There is no
// dropdown to choose YouTube or TikTok, because a dropdown is a second thing
// to get wrong: pick "YouTube", paste a TikTok link, and the page renders an
// empty box that nobody notices until a reader mentions it.
//
// THE RULE THAT MATTERS: we never store or render markup that came from a
// person. Only the video's ID is taken out of the link, and the embed URL is
// rebuilt by us from that ID. An admin pasting the "embed code" off YouTube —
// the obvious mistake — is rejected rather than stored, because storing raw
// HTML and putting it in a page is how a magazine article ends up running
// somebody else's script.
//
// Returns { platform, url, embedUrl, thumbnailUrl, error }:
//   platform      'youtube' | 'tiktok' | 'instagram' | 'gdrive'
//   url           the link as given, kept so an editor can see what was pasted
//   embedUrl      the player URL WE construct — the only thing that goes in a frame
//   thumbnailUrl  a real preview image, or null when the platform has no
//                 public one. Only YouTube offers this without an API key,
//                 which is why the other three show a branded panel instead
//                 of a preview frame. Nobody is asked to pick a cover image.
//   error         a sentence for the person who pasted it, when it cannot be used

const PLATFORM_LABELS = {
  youtube: 'YouTube',
  tiktok: 'TikTok',
  instagram: 'Instagram',
  gdrive: 'Google Drive',
};

function nothing() {
  return { platform: null, url: null, embedUrl: null, thumbnailUrl: null, error: null };
}

function fail(message) {
  return { platform: null, url: null, embedUrl: null, thumbnailUrl: null, error: message };
}

function buildVideoEmbed(rawUrl) {
  const u = String(rawUrl == null ? '' : rawUrl).trim();
  if (!u) return nothing();
  if (u.length > 500) return fail('That link is too long to be a video address.');

  // Pasted embed code, not a link. Named explicitly because it is the most
  // common mistake and "invalid link" would leave someone re-pasting the same
  // thing wondering why.
  if (/<\s*(iframe|script|blockquote)/i.test(u)) {
    return fail('Paste the link to the video, not the embed code. Copy the address from your browser bar or the Share button.');
  }

  // Only http(s). A javascript: or data: address would end up as a frame src.
  if (/^[a-z][a-z0-9+.-]*:/i.test(u) && !/^https?:\/\//i.test(u)) {
    return fail('A video link has to start with https://');
  }

  const withScheme = /^https?:\/\//i.test(u) ? u : 'https://' + u;
  let parsed;
  try {
    parsed = new URL(withScheme);
  } catch (e) {
    return fail('That does not look like a link. Copy the video address from your browser bar.');
  }
  const host = parsed.hostname.replace(/^www\./i, '').toLowerCase();

  // ---- YouTube -------------------------------------------------------------
  // watch?v=, youtu.be/, /shorts/, /embed/ and /live/ all carry the same id.
  if (host === 'youtube.com' || host === 'm.youtube.com' || host === 'youtu.be'
      || host === 'youtube-nocookie.com') {
    let id = null;
    if (host === 'youtu.be') {
      id = parsed.pathname.split('/').filter(Boolean)[0] || null;
    } else if (parsed.searchParams.get('v')) {
      id = parsed.searchParams.get('v');
    } else {
      const m = parsed.pathname.match(/\/(?:shorts|embed|live|v)\/([^/?#]+)/);
      if (m) id = m[1];
    }
    if (!id || !/^[\w-]{6,20}$/.test(id)) {
      return fail('That YouTube link does not contain a video. Use the address of the video itself.');
    }
    return {
      platform: 'youtube',
      url: u,
      // nocookie: YouTube's own privacy-preserving host. The player only
      // loads once a reader presses play, so nothing is set before that.
      embedUrl: `https://www.youtube-nocookie.com/embed/${id}`,
      // The one platform that gives a real preview image with no API key,
      // so a YouTube video shows its actual frame with no cover to choose.
      thumbnailUrl: `https://i.ytimg.com/vi/${id}/hqdefault.jpg`,
      error: null,
    };
  }

  // ---- TikTok --------------------------------------------------------------
  if (host === 'tiktok.com' || host === 'vm.tiktok.com' || host === 'vt.tiktok.com') {
    const m = parsed.pathname.match(/\/video\/(\d{6,})/);
    if (m) {
      return {
        platform: 'tiktok', url: u,
        embedUrl: `https://www.tiktok.com/embed/v2/${m[1]}`,
        thumbnailUrl: null, error: null,
      };
    }
    // vm.tiktok.com/XXXX is a short link that only resolves by following a
    // redirect. Rather than fetch it server-side on every save, say plainly
    // what to paste — the full link is one tap away in the TikTok app.
    return fail('Open the TikTok video and copy its full link (the one containing /video/). Short vm.tiktok.com links cannot be embedded.');
  }

  // ---- Instagram -----------------------------------------------------------
  if (host === 'instagram.com') {
    const m = parsed.pathname.match(/\/(reel|reels|p|tv)\/([\w-]+)/);
    if (!m) {
      return fail('That Instagram link is not a post or reel. Open the video and use its own address.');
    }
    // Instagram serves reels under /reel/ and /p/ interchangeably; /p/ is the
    // form its embed accepts.
    const kind = m[1] === 'reels' ? 'reel' : m[1];
    return {
      platform: 'instagram', url: u,
      embedUrl: `https://www.instagram.com/${kind}/${m[2]}/embed/`,
      thumbnailUrl: null, error: null,
    };
  }

  // ---- Google Drive --------------------------------------------------------
  if (host === 'drive.google.com' || host === 'docs.google.com') {
    // /file/d/<id>/view, or ?id=<id> on the older open? links.
    const m = parsed.pathname.match(/\/d\/([\w-]{10,})/);
    const id = m ? m[1] : parsed.searchParams.get('id');
    if (!id || !/^[\w-]{10,}$/.test(id)) {
      return fail('That Google Drive link does not point at a file. Use Share to copy the file link.');
    }
    return {
      platform: 'gdrive', url: u,
      embedUrl: `https://drive.google.com/file/d/${id}/preview`,
      thumbnailUrl: null,
      // Not an error — it saves fine. This is the thing that catches people
      // out, and the only moment we can warn about it is now, since a private
      // file looks identical to a shared one from the outside.
      warning: 'Make sure the file is shared as "Anyone with the link" in Google Drive, or readers will see a sign-in page instead of the video.',
      error: null,
    };
  }

  return fail('Videos can be added from YouTube, TikTok, Instagram or Google Drive.');
}

module.exports = { buildVideoEmbed, PLATFORM_LABELS };
