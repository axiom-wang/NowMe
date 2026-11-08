/* 创作页的渐进增强：原生表单仍可独立完成采访，不在本地持久化素材。 */
(function () {
  'use strict';
  var form = document.querySelector('[data-interview]');
  if (!form) return;

  var material = form.elements.namedItem('material');
  var materialCount = form.querySelector('[data-material-count]');
  material.addEventListener('input', function () {
    materialCount.textContent = material.value.length + ' / ' + material.maxLength;
  });

  form.querySelectorAll('[data-write-in]').forEach(function (input) {
    input.addEventListener('change', function () {
      var details = input.closest('fieldset').querySelector('.create-writein');
      if (input.checked && details) details.open = true;
    });
  });

  var photos = form.elements.namedItem('photos');
  var photoStatus = form.querySelector('[data-photo-status]');
  var photoList = form.querySelector('[data-photo-list]');
  var savedPhotoStatus = photoStatus.textContent;
  var previewReaders = [];
  function releasePreviews() {
    previewReaders.forEach(function (reader) {
      if (reader.readyState === FileReader.LOADING) reader.abort();
    });
    previewReaders = [];
  }
  photos.addEventListener('change', function () {
    releasePreviews();
    photoList.replaceChildren();
    var files = Array.from(photos.files || []);
    var error = files.length > 6 ? '图片最多 6 张，请重新选择。' : files.some(function (file) { return file.size > 2 * 1024 * 1024; }) ? '单张图片不能超过 2 MB，请重新选择。' : '';
    photos.setCustomValidity(error);
    photoStatus.textContent = error || (files.length ? '已选择 ' + files.length + ' 张图片，下次提交时上传。' : savedPhotoStatus);
    photoStatus.classList.toggle('field__error', !!error);
    if (error) return;
    files.forEach(function (file, index) {
      if (!['image/png', 'image/jpeg', 'image/webp', 'image/gif'].includes(file.type)) return;
      // 主站 CSP 仅允许 self / data 图片；读取本地文件，不放宽安全策略。
      var reader = new FileReader();
      previewReaders.push(reader);
      var image = document.createElement('img');
      image.alt = '待上传图片 ' + (index + 1);
      photoList.appendChild(image);
      reader.addEventListener('load', function () {
        if (typeof reader.result === 'string') image.src = reader.result;
      });
      reader.readAsDataURL(file);
    });
  });
  window.addEventListener('pagehide', releasePreviews);

  var styles = Array.from(form.querySelectorAll('.style-option input'));
  var styleStatus = form.querySelector('[data-style-status]');
  function updateStyles() {
    var count = styles.filter(function (input) { return input.checked; }).length;
    var error = count > 2 ? '最多选择 2 个参考，请取消多选的风格。' : '';
    styles.forEach(function (input) { input.setCustomValidity(input.checked ? error : ''); });
    styleStatus.textContent = error || (count ? '已选 ' + count + ' / 2 个参考' : '还没想好？不选也没关系。');
    styleStatus.classList.toggle('field__error', !!error);
  }
  styles.forEach(function (input) { input.addEventListener('change', updateStyles); });
  updateStyles();
})();
