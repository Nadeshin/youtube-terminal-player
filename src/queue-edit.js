// Operasi antrean murni (dipakai mode QUEUEEDIT di index.js). Tak ubah list asli.
export function deleteQueueItem(list, idx) {
  const arr = [...list];
  if (!Number.isInteger(idx) || idx < 1 || idx > arr.length) {
    return { list: arr, message: 'Nomor tidak valid — antrean tidak berubah.' };
  }
  const [rm] = arr.splice(idx - 1, 1);
  return { list: arr, message: `Dihapus dari antrean: "${rm.title}"` };
}

export function swapQueueItems(list, a, b) {
  const arr = [...list];
  if (![a, b].every((x) => Number.isInteger(x) && x >= 1 && x <= arr.length)) {
    return { list: arr, message: 'Nomor tidak valid — antrean tidak berubah.' };
  }
  if (a === b) {
    return { list: arr, message: 'Nomor sama — antrean tidak berubah.' };
  }
  const tmp = arr[a - 1];
  arr[a - 1] = arr[b - 1];
  arr[b - 1] = tmp;
  return { list: arr, message: `Posisi ${a} dan ${b} ditukar: "${arr[a - 1].title}" ↔ "${arr[b - 1].title}".` };
}
