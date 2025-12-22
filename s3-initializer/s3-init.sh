#!/bin/bash
sleep 20
# add minio server
./mc alias set doc-gen-minio/ $MINIOSERVER $MINIOROOTUSER $MINIOROOTPASSWORD

# check and  setup bucket templates
./mc mb doc-gen-minio/templates
./mc policy set public doc-gen-minio/templates
# remove existing files from templates bucket (only inside shared folder)
./mc rm --recursive --force doc-gen-minio/templates/shared/
# load templates
find ./assets/templates -name '.DS_Store' -delete
./mc cp --recursive ./assets/templates/ doc-gen-minio/templates/

# check and  setup bucket document-forms
./mc mb doc-gen-minio/document-forms
./mc policy set public doc-gen-minio/document-forms
# remove existing files from document-forms bucket
./mc rm --recursive --force doc-gen-minio/document-forms/
#load form-templates
find ./assets/document-forms -name '.DS_Store' -delete
./mc cp --recursive ./assets/document-forms/ doc-gen-minio/document-forms/

# check and  setup bucket attachments
./mc mb doc-gen-minio/attachments
./mc policy set public doc-gen-minio/attachments

#load bucket attachment assets
./mc cp ./assets/attachments/* doc-gen-minio/attachments

./mc mb doc-gen-minio/content-controls
./mc policy set public doc-gen-minio/content-controls

exit 0
