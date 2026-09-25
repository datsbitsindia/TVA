function parseISTDate(value) {
    if (!value) return null;
    if (value instanceof Date) return isNaN(value.getTime()) ? null : value;
    let str = String(value).trim();
    if (!str || str === '0000-00-00' || str === '0000-00-00 00:00:00') return null;

    if (/^\d{4}-\d{2}-\d{2}$/.test(str)) {
        str = str + 'T00:00:00+05:30';
    } else if (!str.includes('Z') && !str.includes('+') && !str.includes('GMT')) {
        str = str.replace(' ', 'T') + '+05:30';
    }

    let d = new Date(str);
    if (!isNaN(d.getTime())) return d;

    d = new Date(value);
    return isNaN(d.getTime()) ? null : d;
}

function formatDate(value) {
    if (!value) return '—';
    try {
        const d = parseISTDate(value);
        if (!d) return '—';
        return new Intl.DateTimeFormat('en-IN', {
            dateStyle: 'medium',
            timeZone: 'Asia/Kolkata'
        }).format(d);
    } catch (e) {
        return '—';
    }
}

function formatDateTime(value) {
    if (!value) return '—';
    try {
        const d = parseISTDate(value);
        if (!d) return '—';
        return new Intl.DateTimeFormat('en-IN', {
            dateStyle: 'medium',
            timeStyle: 'short',
            hour12: true,
            timeZone: 'Asia/Kolkata'
        }).format(d);
    } catch (e) {
        return '—';
    }
}

function safeReturn(value, fallback = '/dashboard') {
    return typeof value === 'string' && value.startsWith('/') && !value.startsWith('//') ? value : fallback;
}

function stripHyperlinks(htmlOrText) {
    if (!htmlOrText || typeof htmlOrText !== 'string') return htmlOrText;
    let cleaned = htmlOrText;
    cleaned = cleaned.replace(/<a\b[^>]*>([\s\S]*?)<\/a>/gi, '$1');
    cleaned = cleaned.replace(/<\/a>/gi, '').replace(/<a\b[^>]*>/gi, '');
    return cleaned;
}

module.exports = { formatDate, formatDateTime, safeReturn, stripHyperlinks };
