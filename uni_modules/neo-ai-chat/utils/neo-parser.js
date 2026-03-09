import MarkdownIt from 'markdown-it';
import hljs from 'highlight.js/lib/core';

// 引入常用语言包
import javascript from 'highlight.js/lib/languages/javascript';
import python from 'highlight.js/lib/languages/python';
import java from 'highlight.js/lib/languages/java';
import json from 'highlight.js/lib/languages/json';
import bash from 'highlight.js/lib/languages/bash';
import sql from 'highlight.js/lib/languages/sql';
import xml from 'highlight.js/lib/languages/xml';
import css from 'highlight.js/lib/languages/css';
import scss from 'highlight.js/lib/languages/scss';

// 注册语言
hljs.registerLanguage('javascript', javascript);
hljs.registerLanguage('python', python);
hljs.registerLanguage('java', java);
hljs.registerLanguage('json', json);
hljs.registerLanguage('bash', bash);
hljs.registerLanguage('sql', sql);
hljs.registerLanguage('xml', xml);
hljs.registerLanguage('html', xml);
hljs.registerLanguage('css', css);
hljs.registerLanguage('scss', scss);

const md = new MarkdownIt({
  html: false, // 禁用 HTML 标签，防 XSS
  breaks: true,
  linkify: true,
  typographer: true,
  highlight: function (str, lang) {
    // 1. 尝试高亮
    let highlighted = '';
    let language = lang || 'text';

    if (lang && hljs.getLanguage(lang)) {
      try {
        highlighted = hljs.highlight(str, { language: lang }).value;
      } catch (__) {
        highlighted = md.utils.escapeHtml(str);
      }
    } else {
      highlighted = md.utils.escapeHtml(str);
    }

    // 2. 关键修改：输出极简结构，不要在这里拼接复杂的 Header HTML
    // 我们把语言类型放在 data-lang 属性里，方便 Vue 组件提取
    // 这里的 \n 是为了保证正则匹配时不会因为紧凑而失效
    return `<div class="neo-code-block" data-lang="${language}">
<pre class="hljs"><code>${highlighted}</code></pre>
</div>`;
  }
});

export default {
  render(markdownText) {
    if (!markdownText) return '';
    return md.render(markdownText);
  }
};