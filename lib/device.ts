const KEY = "proxyproof.device.v1";

export function getDeviceSecret() {
  let value = localStorage.getItem(KEY);
  if (!value || value.length < 16) {
    value = `${crypto.randomUUID()}${crypto.randomUUID()}`.replace(/-/g, "");
    localStorage.setItem(KEY, value);
  }
  return value;
}

export function deviceLabel() {
  const ua = navigator.userAgent;
  if (/iPhone/.test(ua)) return "iPhone";
  if (/iPad/.test(ua)) return "iPad";
  if (/Android/.test(ua)) return "Android";
  if (/Mac/.test(ua)) return "Mac";
  if (/Windows/.test(ua)) return "Windows";
  return "This browser";
}
