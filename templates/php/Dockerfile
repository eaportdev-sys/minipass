# minipass template
# Universal PHP template: works for Laravel, Symfony, Slim, plain PHP, etc.
# Includes common extensions and composer install with caching.
FROM php:8.2-apache

# Enable Apache rewrite for .htaccess (Laravel, Symfony, etc.)
RUN a2enmod rewrite

# Install common PHP extensions needed by most frameworks
RUN apt-get update && apt-get install -y --no-install-recommends \
    libzip-dev libpng-dev libonig-dev libxml2-dev libpq-dev libsqlite3-dev \
    && docker-php-ext-install -j$(nproc) pdo pdo_mysql pdo_pgsql pdo_sqlite zip mbstring xml gd bcmath \
    && rm -rf /var/lib/apt/lists/*

# Install Composer
COPY --from=composer:2 /usr/bin/composer /usr/bin/composer

WORKDIR /var/www/html

# Copy composer manifests first for layer caching
COPY composer.json composer.lock* ./

# Install PHP dependencies. Composer install is cached when lockfile unchanged.
RUN if [ -f composer.lock ]; then composer install --no-dev --no-interaction --prefer-dist --optimize-autoloader; else composer install --no-dev --no-interaction --prefer-dist --optimize-autoloader || true; fi

# Copy application source
COPY . .

# Laravel/Symfony: ensure storage and cache directories are writable
RUN mkdir -p storage/framework/{cache,sessions,views} bootstrap/cache 2>/dev/null || true \
    && chown -R www-data:www-data storage bootstrap/cache 2>/dev/null || true

EXPOSE 80