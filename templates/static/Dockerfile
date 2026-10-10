# minipass template
# Universal static template: serves pre-built files or simple HTML/CSS/JS.
FROM nginx:alpine

COPY . /usr/share/nginx/html/
COPY nginx.conf /etc/nginx/conf.d/default.conf
EXPOSE 80